import { Buffer } from "node:buffer";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";

import { canonicalJson } from "../security/canonical-json.js";
import type {
  LocalQueueEncryptionKey,
  LocalQueueKeyProvider,
} from "./local-queue-key-provider.js";
import { validateLocalQueueEncryptionKey } from "./local-queue-key-provider.js";

const ENVELOPE_VERSION = "kab.encrypted-local-queue.v1" as const;
const STATE_VERSION = "kab.local-queue-state.v1" as const;
const ALGORITHM = "A256GCM" as const;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const DEFAULT_MAX_ITEMS = 1_000;
const DEFAULT_MAX_PAYLOAD_BYTES = 256 * 1024;
const DEFAULT_MAX_STATE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_IDENTIFIER_LENGTH = 256;

export interface EncryptedLocalQueueItem<TPayload = unknown> {
  id: string;
  kind: string;
  createdAt: string;
  expiresAt: string;
  payload: TPayload;
}

export interface EncryptedLocalQueueEnqueue<TPayload = unknown> {
  id: string;
  kind: string;
  payload: TPayload;
  ttlMs: number;
}

export interface EncryptedLocalQueueOptions {
  scope: string;
  maxItems?: number | undefined;
  maxPayloadBytes?: number | undefined;
  maxStateBytes?: number | undefined;
  maxTtlMs?: number | undefined;
  now?: (() => Date) | undefined;
}

interface QueueStateV1 {
  version: typeof STATE_VERSION;
  scope: string;
  items: EncryptedLocalQueueItem[];
}

interface EncryptedQueueEnvelopeV1 {
  version: typeof ENVELOPE_VERSION;
  algorithm: typeof ALGORITHM;
  keyId: string;
  nonce: string;
  ciphertext: string;
  authTag: string;
}

/**
 * Small crash-safe encrypted queue for temporary operational state.
 *
 * It is intentionally not a business datastore: entries require TTL, the
 * queue is bounded by item/payload/state limits, and callers acknowledge/remove
 * entries once delivery/reconciliation is complete.
 */
export class EncryptedLocalQueue<TPayload = unknown> {
  private readonly scope: string;
  private readonly maxItems: number;
  private readonly maxPayloadBytes: number;
  private readonly maxStateBytes: number;
  private readonly maxTtlMs: number;
  private readonly now: () => Date;
  private operation: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly keyProvider: LocalQueueKeyProvider,
    options: EncryptedLocalQueueOptions,
  ) {
    this.scope = validateIdentifier(options.scope, "scope");
    this.maxItems = normalizeLimit(options.maxItems ?? DEFAULT_MAX_ITEMS, 1, 100_000, "maxItems");
    this.maxPayloadBytes = normalizeLimit(
      options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
      1,
      16 * 1024 * 1024,
      "maxPayloadBytes",
    );
    this.maxStateBytes = normalizeLimit(
      options.maxStateBytes ?? DEFAULT_MAX_STATE_BYTES,
      1_024,
      128 * 1024 * 1024,
      "maxStateBytes",
    );
    this.maxTtlMs = normalizeLimit(
      options.maxTtlMs ?? DEFAULT_MAX_TTL_MS,
      1_000,
      365 * 24 * 60 * 60 * 1_000,
      "maxTtlMs",
    );
    this.now = options.now ?? (() => new Date());
  }

  async enqueue(input: EncryptedLocalQueueEnqueue<TPayload>): Promise<EncryptedLocalQueueItem<TPayload>> {
    const id = validateIdentifier(input.id, "item id");
    const kind = validateIdentifier(input.kind, "item kind");
    const ttlMs = normalizeLimit(input.ttlMs, 1, this.maxTtlMs, "ttlMs");
    const payload = structuredClone(input.payload);
    const encodedPayload = canonicalJson(payload);
    if (Buffer.byteLength(encodedPayload, "utf8") > this.maxPayloadBytes) {
      throw new Error("Local queue payload exceeds the configured byte limit.");
    }

    return this.withLock(async () => {
      const state = await this.loadState();
      const changed = pruneExpiredItems(state, this.timestamp());
      if (state.items.some((item) => item.id === id)) {
        throw new Error("Local queue item ID already exists.");
      }
      if (state.items.length >= this.maxItems) {
        throw new Error("Local queue item limit reached.");
      }

      const createdAt = this.timestamp();
      const expiresAt = new Date(Date.parse(createdAt) + ttlMs).toISOString();
      const item: EncryptedLocalQueueItem<TPayload> = {
        id,
        kind,
        createdAt,
        expiresAt,
        payload,
      };
      state.items.push(structuredClone(item));
      await this.writeState(state);
      void changed;
      return structuredClone(item);
    });
  }

  async peek(limit: number): Promise<readonly EncryptedLocalQueueItem<TPayload>[]> {
    const normalizedLimit = normalizeLimit(limit, 1, 500, "peek limit");
    return this.withLock(async () => {
      const state = await this.loadState();
      if (pruneExpiredItems(state, this.timestamp())) {
        await this.writeState(state);
      }
      return state.items
        .slice(0, normalizedLimit)
        .map((item) => structuredClone(item) as EncryptedLocalQueueItem<TPayload>);
    });
  }

  async acknowledge(itemIds: readonly string[]): Promise<number> {
    if (!Array.isArray(itemIds) || itemIds.length < 1 || itemIds.length > 500) {
      throw new Error("Local queue acknowledgement must contain 1-500 item IDs.");
    }
    const ids = new Set(itemIds.map((itemId) => validateIdentifier(itemId, "item id")));
    if (ids.size !== itemIds.length) {
      throw new Error("Local queue acknowledgement contains duplicate item IDs.");
    }

    return this.withLock(async () => {
      const state = await this.loadState();
      pruneExpiredItems(state, this.timestamp());
      const before = state.items.length;
      state.items = state.items.filter((item) => !ids.has(item.id));
      const removed = before - state.items.length;
      if (removed > 0 || state.items.length !== before) {
        await this.writeState(state);
      }
      return removed;
    });
  }

  async pruneExpired(): Promise<number> {
    return this.withLock(async () => {
      const state = await this.loadState();
      const before = state.items.length;
      if (pruneExpiredItems(state, this.timestamp())) {
        await this.writeState(state);
      }
      return before - state.items.length;
    });
  }

  async size(): Promise<number> {
    return this.withLock(async () => {
      const state = await this.loadState();
      if (pruneExpiredItems(state, this.timestamp())) {
        await this.writeState(state);
      }
      return state.items.length;
    });
  }

  /** Force a re-encryption using the provider's current active key. */
  async rewrap(): Promise<void> {
    await this.withLock(async () => {
      const state = await this.loadState();
      pruneExpiredItems(state, this.timestamp());
      await this.writeState(state);
    });
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    let release: (() => void) | undefined;
    const previous = this.operation;
    this.operation = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release?.();
    }
  }

  private async loadState(): Promise<QueueStateV1> {
    let serialized: string;
    try {
      serialized = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isFileNotFound(error)) {
        return { version: STATE_VERSION, scope: this.scope, items: [] };
      }
      throw new Error("Encrypted local queue could not be read.", { cause: error });
    }

    if (Buffer.byteLength(serialized, "utf8") > this.maxStateBytes * 2) {
      throw new Error("Encrypted local queue file exceeds the configured safety limit.");
    }

    let envelope: EncryptedQueueEnvelopeV1;
    try {
      envelope = JSON.parse(serialized) as EncryptedQueueEnvelopeV1;
      validateEnvelope(envelope);
    } catch (error) {
      throw new Error("Encrypted local queue envelope is malformed or unsupported.", { cause: error });
    }

    let resolved: LocalQueueEncryptionKey | null;
    try {
      resolved = await this.keyProvider.getKey(envelope.keyId);
    } catch (error) {
      throw new Error("Encrypted local queue key lookup failed.", { cause: error });
    }
    if (!resolved) {
      throw new Error("Encrypted local queue decryption key is unavailable.");
    }
    const key = validateLocalQueueEncryptionKey(resolved);
    if (key.keyId !== envelope.keyId) {
      throw new Error("Encrypted local queue key resolver returned a mismatched key ID.");
    }

    let plaintext: Buffer;
    try {
      const nonce = decodeBase64Url(envelope.nonce, NONCE_BYTES, "nonce");
      const ciphertext = decodeBase64Url(envelope.ciphertext, undefined, "ciphertext");
      const authTag = decodeBase64Url(envelope.authTag, TAG_BYTES, "authentication tag");
      const decipher = createDecipheriv("aes-256-gcm", key.key, nonce, {
        authTagLength: TAG_BYTES,
      });
      decipher.setAAD(Buffer.from(aad(this.scope, envelope.keyId), "utf8"));
      decipher.setAuthTag(authTag);
      plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch (error) {
      throw new Error("Encrypted local queue authentication or decryption failed.", { cause: error });
    }

    if (plaintext.byteLength > this.maxStateBytes) {
      throw new Error("Encrypted local queue plaintext exceeds the configured state limit.");
    }

    let state: QueueStateV1;
    try {
      state = JSON.parse(plaintext.toString("utf8")) as QueueStateV1;
      validateState(state, this.scope, this.maxItems, this.maxPayloadBytes, this.maxTtlMs);
    } catch (error) {
      throw new Error("Encrypted local queue state is malformed or unsupported.", { cause: error });
    } finally {
      plaintext.fill(0);
    }
    return state;
  }

  private async writeState(state: QueueStateV1): Promise<void> {
    validateState(state, this.scope, this.maxItems, this.maxPayloadBytes, this.maxTtlMs);
    const plaintext = Buffer.from(canonicalJson(state), "utf8");
    if (plaintext.byteLength > this.maxStateBytes) {
      plaintext.fill(0);
      throw new Error("Encrypted local queue state exceeds the configured byte limit.");
    }

    let active: LocalQueueEncryptionKey;
    try {
      active = validateLocalQueueEncryptionKey(await this.keyProvider.getActiveKey());
    } catch (error) {
      plaintext.fill(0);
      throw new Error("Encrypted local queue active key is unavailable.", { cause: error });
    }

    const nonce = randomBytes(NONCE_BYTES);
    let ciphertext: Buffer;
    let authTag: Buffer;
    try {
      const cipher = createCipheriv("aes-256-gcm", active.key, nonce, {
        authTagLength: TAG_BYTES,
      });
      cipher.setAAD(Buffer.from(aad(this.scope, active.keyId), "utf8"));
      ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      authTag = cipher.getAuthTag();
    } finally {
      plaintext.fill(0);
    }

    const envelope: EncryptedQueueEnvelopeV1 = {
      version: ENVELOPE_VERSION,
      algorithm: ALGORITHM,
      keyId: active.keyId,
      nonce: nonce.toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
      authTag: authTag.toString("base64url"),
    };

    const directory = dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700).catch(() => undefined);
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(envelope)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporaryPath, this.filePath);
      await chmod(this.filePath, 0o600).catch(() => undefined);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw new Error("Encrypted local queue state could not be persisted.", { cause: error });
    }
  }

  private timestamp(): string {
    const date = this.now();
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
      throw new Error("Encrypted local queue clock returned an invalid Date.");
    }
    return date.toISOString();
  }
}

function validateEnvelope(value: EncryptedQueueEnvelopeV1): void {
  if (
    !value ||
    value.version !== ENVELOPE_VERSION ||
    value.algorithm !== ALGORITHM ||
    typeof value.keyId !== "string" ||
    typeof value.nonce !== "string" ||
    typeof value.ciphertext !== "string" ||
    typeof value.authTag !== "string"
  ) {
    throw new Error("Unsupported encrypted local queue envelope.");
  }
  validateIdentifier(value.keyId, "keyId");
}

function validateState(
  state: QueueStateV1,
  expectedScope: string,
  maxItems: number,
  maxPayloadBytes: number,
  maxTtlMs: number,
): void {
  if (
    !state ||
    state.version !== STATE_VERSION ||
    state.scope !== expectedScope ||
    !Array.isArray(state.items) ||
    state.items.length > maxItems
  ) {
    throw new Error("Local queue state is invalid for this runtime scope.");
  }

  const seen = new Set<string>();
  for (const item of state.items) {
    validateIdentifier(item.id, "item id");
    validateIdentifier(item.kind, "item kind");
    if (seen.has(item.id)) throw new Error("Local queue state contains duplicate item IDs.");
    seen.add(item.id);
    const created = Date.parse(item.createdAt);
    const expires = Date.parse(item.expiresAt);
    if (!Number.isFinite(created) || !Number.isFinite(expires) || expires <= created) {
      throw new Error("Local queue item timestamps are invalid.");
    }
    if (expires - created > maxTtlMs) {
      throw new Error("Local queue item TTL exceeds the configured maximum.");
    }
    if (Buffer.byteLength(canonicalJson(item.payload), "utf8") > maxPayloadBytes) {
      throw new Error("Local queue item payload exceeds the configured byte limit.");
    }
  }
}

function pruneExpiredItems(state: QueueStateV1, nowIso: string): boolean {
  const now = Date.parse(nowIso);
  const before = state.items.length;
  state.items = state.items.filter((item) => Date.parse(item.expiresAt) > now);
  return state.items.length !== before;
}

function aad(scope: string, keyId: string): string {
  return `${ENVELOPE_VERSION}|${ALGORITHM}|${scope}|${keyId}`;
}

function decodeBase64Url(
  value: string,
  expectedBytes: number | undefined,
  label: string,
): Buffer {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) {
    throw new Error(`Encrypted local queue ${label} is not base64url.`);
  }
  const decoded = Buffer.from(value, "base64url");
  if (expectedBytes !== undefined && decoded.byteLength !== expectedBytes) {
    throw new Error(`Encrypted local queue ${label} has an invalid length.`);
  }
  return decoded;
}

function validateIdentifier(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`Local queue ${label} is invalid.`);
  }
  return value;
}

function normalizeLimit(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function isFileNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

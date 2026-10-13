import {
  createPublicKey,
  randomUUID,
  verify as verifySignature,
} from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { InstallationBinding, TrustedApprovalKey } from "../control-channel/enrollment.js";
import { canonicalJson } from "./canonical-json.js";

export interface ApprovalKeySetState {
  version: "kab.approval-keyset-state.v1";
  tenantId: string;
  installationId: string;
  bridgeInstanceId: string;
  generation: number;
  keys: readonly TrustedApprovalKey[];
  updatedAt: string;
}

export interface ApprovalKeySetPayload {
  version: "kab.approval-keyset.v1";
  tenantId: string;
  installationId: string;
  bridgeInstanceId: string;
  generation: number;
  keys: readonly TrustedApprovalKey[];
  issuedAt: string;
}

export interface SignedApprovalKeySet {
  payload: ApprovalKeySetPayload;
  signerKeyId: string;
  signature: string;
}

export interface ApprovalKeySetStore {
  load(): Promise<ApprovalKeySetState | null>;
  save(state: ApprovalKeySetState): Promise<void>;
}

export class InMemoryApprovalKeySetStore implements ApprovalKeySetStore {
  private state: ApprovalKeySetState | null = null;

  async load(): Promise<ApprovalKeySetState | null> {
    return this.state ? structuredClone(this.state) : null;
  }

  async save(state: ApprovalKeySetState): Promise<void> {
    this.state = structuredClone(state);
  }
}

export class FileApprovalKeySetStore implements ApprovalKeySetStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<ApprovalKeySetState | null> {
    try {
      const content = await readFile(this.filePath, "utf8");
      return JSON.parse(content) as ApprovalKeySetState;
    } catch (error) {
      if (isFileNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  async save(state: ApprovalKeySetState): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;

    try {
      await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

export interface ApprovalKeySetManagerOptions {
  now?: (() => Date) | undefined;
  maxClockSkewMs?: number | undefined;
}

export class ApprovalKeySetManager {
  private readonly now: () => Date;
  private readonly maxClockSkewMs: number;

  constructor(
    private readonly binding: InstallationBinding,
    private readonly store: ApprovalKeySetStore,
    options: ApprovalKeySetManagerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.maxClockSkewMs = options.maxClockSkewMs ?? 30_000;
  }

  async getOrBootstrap(): Promise<ApprovalKeySetState> {
    const stored = await this.store.load();

    if (stored) {
      this.validateStateScope(stored);
      this.validateKeys(stored.keys);
      return stored;
    }

    this.validateKeys(this.binding.trustedApprovalKeys);

    const state: ApprovalKeySetState = {
      version: "kab.approval-keyset-state.v1",
      tenantId: this.binding.tenantId,
      installationId: this.binding.installationId,
      bridgeInstanceId: this.binding.bridgeInstanceId,
      generation: 0,
      keys: structuredClone(this.binding.trustedApprovalKeys),
      updatedAt: this.now().toISOString(),
    };

    await this.store.save(state);
    return state;
  }

  async resolvePublicKey(keyId: string): Promise<string | Buffer | null> {
    const state = await this.getOrBootstrap();
    const key = state.keys.find((candidate) => candidate.keyId === keyId);

    if (!key || !isKeyActive(key, this.now())) {
      return null;
    }

    return key.publicKeyPem;
  }

  async apply(update: SignedApprovalKeySet): Promise<ApprovalKeySetState> {
    const current = await this.getOrBootstrap();
    const { payload } = update;

    if (payload.version !== "kab.approval-keyset.v1") {
      throw new Error("Unsupported approval keyset version.");
    }

    if (
      payload.tenantId !== current.tenantId ||
      payload.installationId !== current.installationId ||
      payload.bridgeInstanceId !== current.bridgeInstanceId
    ) {
      throw new Error("Approval keyset scope does not match this bridge installation.");
    }

    if (!Number.isInteger(payload.generation) || payload.generation <= current.generation) {
      throw new Error("Approval keyset generation is not newer than the current generation.");
    }

    const issuedAt = Date.parse(payload.issuedAt);
    const now = this.now();

    if (!Number.isFinite(issuedAt) || issuedAt > now.getTime() + this.maxClockSkewMs) {
      throw new Error("Approval keyset issuedAt is invalid.");
    }

    const signer = current.keys.find((key) => key.keyId === update.signerKeyId);

    if (!signer || !isKeyActive(signer, now)) {
      throw new Error("Approval keyset signer is not currently trusted.");
    }

    let signatureValid = false;

    try {
      signatureValid = verifySignature(
        null,
        Buffer.from(canonicalJson(payload), "utf8"),
        createPublicKey(signer.publicKeyPem),
        Buffer.from(update.signature, "base64url"),
      );
    } catch {
      throw new Error("Approval keyset signature could not be verified.");
    }

    if (!signatureValid) {
      throw new Error("Approval keyset signature is invalid.");
    }

    this.validateKeys(payload.keys);

    if (!payload.keys.some((key) => isKeyActive(key, now))) {
      throw new Error("Approval keyset would leave the runtime without an active approval key.");
    }

    const next: ApprovalKeySetState = {
      version: "kab.approval-keyset-state.v1",
      tenantId: payload.tenantId,
      installationId: payload.installationId,
      bridgeInstanceId: payload.bridgeInstanceId,
      generation: payload.generation,
      keys: structuredClone(payload.keys),
      updatedAt: now.toISOString(),
    };

    await this.store.save(next);
    return next;
  }

  private validateStateScope(state: ApprovalKeySetState): void {
    if (state.version !== "kab.approval-keyset-state.v1") {
      throw new Error("Unsupported persisted approval keyset state version.");
    }

    if (
      state.tenantId !== this.binding.tenantId ||
      state.installationId !== this.binding.installationId ||
      state.bridgeInstanceId !== this.binding.bridgeInstanceId
    ) {
      throw new Error("Persisted approval keyset belongs to another installation.");
    }
  }

  private validateKeys(keys: readonly TrustedApprovalKey[]): void {
    if (keys.length === 0) {
      throw new Error("Approval keyset must contain at least one key.");
    }

    const ids = new Set<string>();

    for (const key of keys) {
      if (!key.keyId || !key.publicKeyPem || ids.has(key.keyId)) {
        throw new Error("Approval keyset contains an invalid or duplicate key.");
      }

      ids.add(key.keyId);
      createPublicKey(key.publicKeyPem);

      if (key.notBefore && !Number.isFinite(Date.parse(key.notBefore))) {
        throw new Error("Approval key notBefore is invalid.");
      }

      if (key.notAfter && !Number.isFinite(Date.parse(key.notAfter))) {
        throw new Error("Approval key notAfter is invalid.");
      }

      if (
        key.notBefore &&
        key.notAfter &&
        Date.parse(key.notAfter) <= Date.parse(key.notBefore)
      ) {
        throw new Error("Approval key validity window is invalid.");
      }
    }
  }
}

export function isKeyActive(key: TrustedApprovalKey, now: Date): boolean {
  const timestamp = now.getTime();

  if (key.notBefore && Date.parse(key.notBefore) > timestamp) {
    return false;
  }

  if (key.notAfter && Date.parse(key.notAfter) < timestamp) {
    return false;
  }

  return true;
}

function isFileNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

import { Buffer } from "node:buffer";

const KEY_BYTES = 32;
const MAX_KEY_ID_LENGTH = 128;

export interface LocalQueueEncryptionKey {
  keyId: string;
  /** Raw 32-byte AES-256 key material. Never serialize this value. */
  key: Uint8Array;
}

export interface LocalQueueKeyProvider {
  getActiveKey(): Promise<LocalQueueEncryptionKey>;
  getKey(keyId: string): Promise<LocalQueueEncryptionKey | null>;
}

/**
 * Small mutable provider intended for tests/local embedding and as a reference
 * implementation. Production deployments should back the same contract with
 * an OS secret store, KMS/HSM adapter or deployment secret provider.
 */
export class InMemoryLocalQueueKeyProvider implements LocalQueueKeyProvider {
  private readonly keys = new Map<string, Buffer>();
  private activeKeyId: string;

  constructor(active: LocalQueueEncryptionKey, additional: readonly LocalQueueEncryptionKey[] = []) {
    const normalizedActive = normalizeKey(active);
    this.activeKeyId = normalizedActive.keyId;
    this.keys.set(normalizedActive.keyId, normalizedActive.key);

    for (const candidate of additional) {
      const normalized = normalizeKey(candidate);
      if (this.keys.has(normalized.keyId)) {
        throw new Error("Local queue key IDs must be unique.");
      }
      this.keys.set(normalized.keyId, normalized.key);
    }
  }

  async getActiveKey(): Promise<LocalQueueEncryptionKey> {
    const key = this.keys.get(this.activeKeyId);
    if (!key) throw new Error("Active local queue encryption key is unavailable.");
    return { keyId: this.activeKeyId, key: Buffer.from(key) };
  }

  async getKey(keyId: string): Promise<LocalQueueEncryptionKey | null> {
    const normalizedId = normalizeKeyId(keyId);
    const key = this.keys.get(normalizedId);
    return key ? { keyId: normalizedId, key: Buffer.from(key) } : null;
  }

  addKey(value: LocalQueueEncryptionKey, makeActive = false): void {
    const normalized = normalizeKey(value);
    const existing = this.keys.get(normalized.keyId);
    if (existing && !existing.equals(normalized.key)) {
      throw new Error("Local queue key ID already refers to different key material.");
    }
    this.keys.set(normalized.keyId, normalized.key);
    if (makeActive) this.activeKeyId = normalized.keyId;
  }

  setActiveKey(keyId: string): void {
    const normalizedId = normalizeKeyId(keyId);
    if (!this.keys.has(normalizedId)) {
      throw new Error("Cannot activate an unknown local queue key ID.");
    }
    this.activeKeyId = normalizedId;
  }

  removeKey(keyId: string): void {
    const normalizedId = normalizeKeyId(keyId);
    if (normalizedId === this.activeKeyId) {
      throw new Error("Cannot remove the active local queue key.");
    }
    this.keys.delete(normalizedId);
  }
}

export function validateLocalQueueEncryptionKey(
  value: LocalQueueEncryptionKey,
): LocalQueueEncryptionKey {
  const normalized = normalizeKey(value);
  return { keyId: normalized.keyId, key: Buffer.from(normalized.key) };
}

function normalizeKey(value: LocalQueueEncryptionKey): { keyId: string; key: Buffer } {
  if (!value || typeof value !== "object") {
    throw new Error("Local queue encryption key is invalid.");
  }
  const keyId = normalizeKeyId(value.keyId);
  const key = Buffer.from(value.key);
  if (key.byteLength !== KEY_BYTES) {
    throw new Error("Local queue encryption keys must be exactly 32 bytes.");
  }
  return { keyId, key };
}

function normalizeKeyId(value: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAX_KEY_ID_LENGTH ||
    !/^[A-Za-z0-9._:-]+$/.test(value)
  ) {
    throw new Error("Local queue key ID is invalid.");
  }
  return value;
}

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
} from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type RuntimeDeploymentMode =
  | "hosted"
  | "local"
  | "hybrid"
  | "embedded";

export interface StoredBridgeIdentity {
  version: "kab.identity.v1";
  bridgeInstanceId: string;
  keyId: string;
  publicKeyPem: string;
  privateKeyPem: string;
  createdAt: string;
}

export interface PublicBridgeIdentity {
  version: "kab.identity.v1";
  bridgeInstanceId: string;
  keyId: string;
  publicKeyPem: string;
  createdAt: string;
}

export interface BridgeIdentityStore {
  load(): Promise<StoredBridgeIdentity | null>;
  save(identity: StoredBridgeIdentity): Promise<void>;
}

export class InMemoryBridgeIdentityStore implements BridgeIdentityStore {
  private identity: StoredBridgeIdentity | null = null;

  async load(): Promise<StoredBridgeIdentity | null> {
    return this.identity ? { ...this.identity } : null;
  }

  async save(identity: StoredBridgeIdentity): Promise<void> {
    this.identity = { ...identity };
  }
}

export class FileBridgeIdentityStore implements BridgeIdentityStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<StoredBridgeIdentity | null> {
    try {
      const content = await readFile(this.filePath, "utf8");
      return JSON.parse(content) as StoredBridgeIdentity;
    } catch (error) {
      if (isFileNotFound(error)) {
        return null;
      }

      throw error;
    }
  }

  async save(identity: StoredBridgeIdentity): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });

    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    const content = `${JSON.stringify(identity, null, 2)}\n`;

    try {
      await writeFile(temporaryPath, content, {
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

function publicKeyFingerprint(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({
    format: "der",
    type: "spki",
  });

  return createHash("sha256").update(der).digest("base64url");
}

function validateStoredIdentity(identity: StoredBridgeIdentity): void {
  if (identity.version !== "kab.identity.v1") {
    throw new Error("Unsupported bridge identity version.");
  }

  const publicKey = createPublicKey(identity.publicKeyPem);
  const privateKey = createPrivateKey(identity.privateKeyPem);
  const derivedPublicKeyPem = createPublicKey(privateKey)
    .export({ format: "pem", type: "spki" })
    .toString();
  const normalizedPublicKeyPem = publicKey
    .export({ format: "pem", type: "spki" })
    .toString();

  if (derivedPublicKeyPem !== normalizedPublicKeyPem) {
    throw new Error("Stored bridge identity key pair does not match.");
  }

  if (publicKeyFingerprint(normalizedPublicKeyPem) !== identity.keyId) {
    throw new Error("Stored bridge identity key ID is invalid.");
  }
}

export function toPublicBridgeIdentity(
  identity: StoredBridgeIdentity,
): PublicBridgeIdentity {
  const { privateKeyPem: _privateKeyPem, ...publicIdentity } = identity;
  return publicIdentity;
}

export class BridgeIdentityManager {
  constructor(
    private readonly store: BridgeIdentityStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async getOrCreate(): Promise<StoredBridgeIdentity> {
    const stored = await this.store.load();

    if (stored) {
      validateStoredIdentity(stored);
      return stored;
    }

    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey
      .export({ format: "pem", type: "spki" })
      .toString();
    const privateKeyPem = privateKey
      .export({ format: "pem", type: "pkcs8" })
      .toString();

    const identity: StoredBridgeIdentity = {
      version: "kab.identity.v1",
      bridgeInstanceId: randomUUID(),
      keyId: publicKeyFingerprint(publicKeyPem),
      publicKeyPem,
      privateKeyPem,
      createdAt: this.now().toISOString(),
    };

    await this.store.save(identity);
    return identity;
  }
}

export function getBridgePublicKeyFingerprint(publicKeyPem: string): string {
  return publicKeyFingerprint(publicKeyPem);
}

function isFileNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

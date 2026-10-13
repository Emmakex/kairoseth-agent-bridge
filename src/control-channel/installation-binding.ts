import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { StoredBridgeIdentity } from "../identity/installation-identity.js";
import type { InstallationBinding } from "./enrollment.js";

export interface InstallationBindingStore {
  load(): Promise<InstallationBinding | null>;
  save(binding: InstallationBinding): Promise<void>;
  clear(): Promise<void>;
}

export class InMemoryInstallationBindingStore implements InstallationBindingStore {
  private binding: InstallationBinding | null = null;

  async load(): Promise<InstallationBinding | null> {
    return this.binding ? structuredClone(this.binding) : null;
  }

  async save(binding: InstallationBinding): Promise<void> {
    this.binding = structuredClone(binding);
  }

  async clear(): Promise<void> {
    this.binding = null;
  }
}

export class FileInstallationBindingStore implements InstallationBindingStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<InstallationBinding | null> {
    try {
      const content = await readFile(this.filePath, "utf8");
      return JSON.parse(content) as InstallationBinding;
    } catch (error) {
      if (isFileNotFound(error)) {
        return null;
      }

      throw error;
    }
  }

  async save(binding: InstallationBinding): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });

    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    const content = `${JSON.stringify(binding, null, 2)}\n`;

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

  async clear(): Promise<void> {
    await rm(this.filePath, { force: true });
  }
}

export function validateInstallationBinding(
  identity: StoredBridgeIdentity,
  binding: InstallationBinding,
): void {
  if (binding.version !== "kab.installation-binding.v1") {
    throw new Error("Unsupported installation binding version.");
  }

  if (!binding.tenantId || !binding.installationId) {
    throw new Error("Installation binding is missing platform scope.");
  }

  if (binding.bridgeInstanceId !== identity.bridgeInstanceId) {
    throw new Error("Installation binding targets a different bridge instance.");
  }

  if (binding.keyId !== identity.keyId) {
    throw new Error("Installation binding targets a different bridge key.");
  }

  if (!Number.isFinite(Date.parse(binding.registeredAt))) {
    throw new Error("Installation binding registration timestamp is invalid.");
  }

  const keyIds = new Set<string>();

  for (const key of binding.trustedApprovalKeys) {
    if (!key.keyId || !key.publicKeyPem) {
      throw new Error("Installation binding contains an invalid approval key.");
    }

    if (keyIds.has(key.keyId)) {
      throw new Error("Installation binding contains duplicate approval key IDs.");
    }

    keyIds.add(key.keyId);
  }
}

export class InstallationBindingManager {
  constructor(
    private readonly store: InstallationBindingStore,
    private readonly loadIdentity: () => Promise<StoredBridgeIdentity>,
  ) {}

  async load(): Promise<InstallationBinding | null> {
    const binding = await this.store.load();

    if (!binding) {
      return null;
    }

    const identity = await this.loadIdentity();
    validateInstallationBinding(identity, binding);
    return binding;
  }

  async require(): Promise<InstallationBinding> {
    const binding = await this.load();

    if (!binding) {
      throw new Error("Bridge runtime is not enrolled.");
    }

    return binding;
  }

  async save(binding: InstallationBinding): Promise<void> {
    const identity = await this.loadIdentity();
    validateInstallationBinding(identity, binding);
    await this.store.save(binding);
  }

  async clear(): Promise<void> {
    await this.store.clear();
  }
}

function isFileNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

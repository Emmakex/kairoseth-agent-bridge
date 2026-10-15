import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type RuntimeProcessState =
  | "starting"
  | "ready"
  | "degraded"
  | "stopped"
  | "failed";

export interface RuntimeProcessStatus {
  version: "kab.runtime-process-status.v1";
  pid: number;
  runtimeVersion: string;
  state: RuntimeProcessState;
  updatedAt: string;
}

export interface RuntimeProcessHealthOptions {
  maxAgeMs?: number | undefined;
  now?: (() => Date) | undefined;
  isProcessAlive?: ((pid: number) => boolean) | undefined;
}

const DEFAULT_MAX_AGE_MS = 90_000;

export class FileRuntimeProcessStatusStore {
  constructor(
    private readonly filePath: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async write(
    state: RuntimeProcessState,
    runtimeVersion: string,
    pid: number = process.pid,
  ): Promise<RuntimeProcessStatus> {
    if (!runtimeVersion.trim()) {
      throw new Error("Runtime process status requires a runtime version.");
    }
    if (!Number.isInteger(pid) || pid < 1) {
      throw new Error("Runtime process status requires a valid PID.");
    }

    const status: RuntimeProcessStatus = {
      version: "kab.runtime-process-status.v1",
      pid,
      runtimeVersion: runtimeVersion.trim(),
      state,
      updatedAt: this.now().toISOString(),
    };

    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;

    try {
      await writeFile(temporaryPath, `${JSON.stringify(status, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }

    return status;
  }

  async read(): Promise<RuntimeProcessStatus | null> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      return validateRuntimeProcessStatus(parsed);
    } catch (error) {
      if (isFileNotFound(error)) return null;
      throw error;
    }
  }

  async healthy(options: RuntimeProcessHealthOptions = {}): Promise<boolean> {
    const status = await this.read();
    if (!status) return false;

    if (status.state !== "ready" && status.state !== "degraded") {
      return false;
    }

    const now = options.now ?? (() => new Date());
    const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    if (!Number.isFinite(maxAgeMs) || maxAgeMs < 1_000) {
      throw new Error("Runtime process health max age must be at least 1000ms.");
    }

    const updatedAt = Date.parse(status.updatedAt);
    if (!Number.isFinite(updatedAt)) return false;
    const ageMs = now().getTime() - updatedAt;
    if (ageMs < 0 || ageMs > maxAgeMs) return false;

    const isProcessAlive = options.isProcessAlive ?? defaultProcessAlive;
    return isProcessAlive(status.pid);
  }
}

export function validateRuntimeProcessStatus(value: unknown): RuntimeProcessStatus {
  if (!value || typeof value !== "object") {
    throw new Error("Runtime process status is invalid.");
  }

  const candidate = value as Partial<RuntimeProcessStatus>;
  if (candidate.version !== "kab.runtime-process-status.v1") {
    throw new Error("Unsupported runtime process status version.");
  }
  if (!Number.isInteger(candidate.pid) || (candidate.pid ?? 0) < 1) {
    throw new Error("Runtime process status PID is invalid.");
  }
  if (!candidate.runtimeVersion?.trim()) {
    throw new Error("Runtime process status version is missing.");
  }
  if (
    candidate.state !== "starting" &&
    candidate.state !== "ready" &&
    candidate.state !== "degraded" &&
    candidate.state !== "stopped" &&
    candidate.state !== "failed"
  ) {
    throw new Error("Runtime process status state is invalid.");
  }
  if (!candidate.updatedAt || !Number.isFinite(Date.parse(candidate.updatedAt))) {
    throw new Error("Runtime process status timestamp is invalid.");
  }

  return candidate as RuntimeProcessStatus;
}

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isFileNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

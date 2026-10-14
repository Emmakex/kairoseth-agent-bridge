import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface ApprovalReplayRecord {
  version: "kab.approval-replay.v1";
  nonce: string;
  tenantId: string;
  installationId: string;
  toolId: string;
  correlationId: string;
  actionFingerprint: string;
  consumedAt: string;
  retainUntil: string;
}

/**
 * Single-use approval replay store.
 *
 * `consume()` MUST be atomic across every runtime instance sharing the store:
 * exactly one caller may consume a nonce and receive `true`; every concurrent
 * or later caller for the same nonce must receive `false`. Clustered backends
 * should implement this with SET NX, a unique insert, conditional write or an
 * equivalent backend-level primitive. A get-then-insert sequence is unsafe.
 */
export interface ApprovalReplayStore {
  consume(record: ApprovalReplayRecord): Promise<boolean>;
  get(nonce: string): Promise<ApprovalReplayRecord | null>;
  prune(now: Date): Promise<number>;
}

export class InMemoryApprovalReplayStore implements ApprovalReplayStore {
  private readonly records = new Map<string, ApprovalReplayRecord>();

  async consume(record: ApprovalReplayRecord): Promise<boolean> {
    if (this.records.has(record.nonce)) {
      return false;
    }

    this.records.set(record.nonce, structuredClone(record));
    return true;
  }

  async get(nonce: string): Promise<ApprovalReplayRecord | null> {
    const record = this.records.get(nonce);
    return record ? structuredClone(record) : null;
  }

  async prune(now: Date): Promise<number> {
    let removed = 0;

    for (const [nonce, record] of this.records.entries()) {
      if (Date.parse(record.retainUntil) <= now.getTime()) {
        this.records.delete(nonce);
        removed += 1;
      }
    }

    return removed;
  }
}

interface ReplayFileV1 {
  version: "kab.approval-replay-store.v1";
  records: ApprovalReplayRecord[];
}

/**
 * Single-process file baseline. Its in-process lock preserves consume
 * atomicity only inside this runtime process. Do not share the same file across
 * independent processes/hosts; clustered deployments must inject a backend
 * implementation that provides atomic consume at the datastore level.
 */
export class FileApprovalReplayStore implements ApprovalReplayStore {
  private operation: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async consume(record: ApprovalReplayRecord): Promise<boolean> {
    return this.withLock(async () => {
      const file = await this.loadFile();

      if (file.records.some((item) => item.nonce === record.nonce)) {
        return false;
      }

      file.records.push(structuredClone(record));
      await this.writeFile(file);
      return true;
    });
  }

  async get(nonce: string): Promise<ApprovalReplayRecord | null> {
    return this.withLock(async () => {
      const file = await this.loadFile();
      const record = file.records.find((item) => item.nonce === nonce);
      return record ? structuredClone(record) : null;
    });
  }

  async prune(now: Date): Promise<number> {
    return this.withLock(async () => {
      const file = await this.loadFile();
      const before = file.records.length;
      file.records = file.records.filter(
        (record) => Date.parse(record.retainUntil) > now.getTime(),
      );
      const removed = before - file.records.length;

      if (removed > 0) {
        await this.writeFile(file);
      }

      return removed;
    });
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    let resolveQueue: (() => void) | undefined;
    const previous = this.operation;
    this.operation = new Promise<void>((resolve) => {
      resolveQueue = resolve;
    });

    await previous.catch(() => undefined);

    try {
      return await operation();
    } finally {
      resolveQueue?.();
    }
  }

  private async loadFile(): Promise<ReplayFileV1> {
    try {
      const content = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(content) as ReplayFileV1;

      if (parsed.version !== "kab.approval-replay-store.v1") {
        throw new Error("Unsupported approval replay store version.");
      }

      if (!Array.isArray(parsed.records)) {
        throw new Error("Approval replay store is malformed.");
      }

      return parsed;
    } catch (error) {
      if (isFileNotFound(error)) {
        return {
          version: "kab.approval-replay-store.v1",
          records: [],
        };
      }

      throw error;
    }
  }

  private async writeFile(file: ReplayFileV1): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });

    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    const content = `${JSON.stringify(file, null, 2)}\n`;

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

function isFileNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface WebhookReplayRecord {
  version: "kab.webhook-replay.v1";
  webhookId: string;
  nonce: string;
  sourceTimestamp: string;
  consumedAt: string;
  retainUntil: string;
}

export interface WebhookReplayStore {
  consume(record: WebhookReplayRecord): Promise<boolean>;
  get(webhookId: string, nonce: string): Promise<WebhookReplayRecord | null>;
  prune(now: Date): Promise<number>;
}

function replayKey(webhookId: string, nonce: string): string {
  return `${webhookId}\u0000${nonce}`;
}

export class InMemoryWebhookReplayStore implements WebhookReplayStore {
  private readonly records = new Map<string, WebhookReplayRecord>();

  async consume(record: WebhookReplayRecord): Promise<boolean> {
    const key = replayKey(record.webhookId, record.nonce);
    if (this.records.has(key)) return false;
    this.records.set(key, structuredClone(record));
    return true;
  }

  async get(
    webhookId: string,
    nonce: string,
  ): Promise<WebhookReplayRecord | null> {
    const record = this.records.get(replayKey(webhookId, nonce));
    return record ? structuredClone(record) : null;
  }

  async prune(now: Date): Promise<number> {
    let removed = 0;
    for (const [key, record] of this.records.entries()) {
      if (Date.parse(record.retainUntil) <= now.getTime()) {
        this.records.delete(key);
        removed += 1;
      }
    }
    return removed;
  }
}

interface ReplayFileV1 {
  version: "kab.webhook-replay-store.v1";
  records: WebhookReplayRecord[];
}

export class FileWebhookReplayStore implements WebhookReplayStore {
  private operation: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async consume(record: WebhookReplayRecord): Promise<boolean> {
    return this.withLock(async () => {
      const file = await this.loadFile();
      if (
        file.records.some(
          (item) =>
            item.webhookId === record.webhookId && item.nonce === record.nonce,
        )
      ) {
        return false;
      }

      file.records.push(structuredClone(record));
      await this.writeStore(file);
      return true;
    });
  }

  async get(
    webhookId: string,
    nonce: string,
  ): Promise<WebhookReplayRecord | null> {
    return this.withLock(async () => {
      const file = await this.loadFile();
      const record = file.records.find(
        (item) => item.webhookId === webhookId && item.nonce === nonce,
      );
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

      if (removed > 0) await this.writeStore(file);
      return removed;
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

  private async loadFile(): Promise<ReplayFileV1> {
    try {
      const content = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(content) as ReplayFileV1;
      if (parsed.version !== "kab.webhook-replay-store.v1") {
        throw new Error("Unsupported webhook replay store version.");
      }
      if (!Array.isArray(parsed.records)) {
        throw new Error("Webhook replay store is malformed.");
      }
      return parsed;
    } catch (error) {
      if (isFileNotFound(error)) {
        return { version: "kab.webhook-replay-store.v1", records: [] };
      }
      throw error;
    }
  }

  private async writeStore(file: ReplayFileV1): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;

    try {
      await writeFile(temporaryPath, `${JSON.stringify(file, null, 2)}\n`, {
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

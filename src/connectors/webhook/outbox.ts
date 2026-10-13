import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  NormalizedWebhookEvent,
  WebhookEventSink,
} from "./contracts.js";

export interface WebhookEventOutboxStore extends WebhookEventSink {
  list(limit?: number): Promise<readonly NormalizedWebhookEvent[]>;
  acknowledge(eventIds: readonly string[]): Promise<number>;
}

export class InMemoryWebhookEventOutboxStore
  implements WebhookEventOutboxStore
{
  private readonly events = new Map<string, NormalizedWebhookEvent>();

  async emit(event: NormalizedWebhookEvent): Promise<void> {
    const existing = this.events.get(event.eventId);
    if (existing) {
      assertSameEvent(existing, event);
      return;
    }
    this.events.set(event.eventId, structuredClone(event));
  }

  async list(limit = 100): Promise<readonly NormalizedWebhookEvent[]> {
    validateLimit(limit);
    return structuredClone([...this.events.values()].slice(0, limit));
  }

  async acknowledge(eventIds: readonly string[]): Promise<number> {
    let removed = 0;
    for (const eventId of new Set(eventIds)) {
      if (this.events.delete(eventId)) removed += 1;
    }
    return removed;
  }
}

interface WebhookOutboxFileV1 {
  version: "kab.webhook-outbox.v1";
  events: NormalizedWebhookEvent[];
}

export class FileWebhookEventOutboxStore implements WebhookEventOutboxStore {
  private operation: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async emit(event: NormalizedWebhookEvent): Promise<void> {
    await this.withLock(async () => {
      const file = await this.loadFile();
      const existing = file.events.find((item) => item.eventId === event.eventId);
      if (existing) {
        assertSameEvent(existing, event);
        return;
      }
      file.events.push(structuredClone(event));
      await this.writeStore(file);
    });
  }

  async list(limit = 100): Promise<readonly NormalizedWebhookEvent[]> {
    validateLimit(limit);
    return this.withLock(async () => {
      const file = await this.loadFile();
      return structuredClone(file.events.slice(0, limit));
    });
  }

  async acknowledge(eventIds: readonly string[]): Promise<number> {
    return this.withLock(async () => {
      const ids = new Set(eventIds);
      if (ids.size === 0) return 0;

      const file = await this.loadFile();
      const before = file.events.length;
      file.events = file.events.filter((event) => !ids.has(event.eventId));
      const removed = before - file.events.length;
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

  private async loadFile(): Promise<WebhookOutboxFileV1> {
    try {
      const content = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(content) as WebhookOutboxFileV1;
      if (parsed.version !== "kab.webhook-outbox.v1") {
        throw new Error("Unsupported webhook outbox version.");
      }
      if (!Array.isArray(parsed.events)) {
        throw new Error("Webhook outbox is malformed.");
      }
      return parsed;
    } catch (error) {
      if (isFileNotFound(error)) {
        return { version: "kab.webhook-outbox.v1", events: [] };
      }
      throw error;
    }
  }

  private async writeStore(file: WebhookOutboxFileV1): Promise<void> {
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

function assertSameEvent(
  existing: NormalizedWebhookEvent,
  incoming: NormalizedWebhookEvent,
): void {
  if (
    existing.webhookId !== incoming.webhookId ||
    existing.nonce !== incoming.nonce ||
    existing.payloadFingerprint !== incoming.payloadFingerprint ||
    existing.sourceTimestamp !== incoming.sourceTimestamp
  ) {
    throw new Error(
      "Webhook event ID conflicts with a different normalized webhook event.",
    );
  }
}

function validateLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error("Webhook outbox list limit must be between 1 and 1000.");
  }
}

function isFileNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

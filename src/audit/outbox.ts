import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type AuditEventTypeV1 =
  | "INVOCATION_RECEIVED"
  | "POLICY_EVALUATED"
  | "EXECUTION_STARTED"
  | "EXECUTION_SUCCEEDED"
  | "EXECUTION_FAILED";

export type AuditRiskLevelV1 = "READ" | "WRITE" | "CRITICAL";
export type AuditPolicyOutcomeV1 = "ALLOW" | "DENY" | "REQUIRE_APPROVAL";
export type AuditInvocationProtocolV1 =
  | "kairoseth-native"
  | "mcp"
  | "a2a"
  | "rest"
  | "webhook"
  | "internal";

export interface SanitizedAuditPrincipalProvenance {
  issuer: string;
  subject: string;
  authenticationMethod: string;
  clientId?: string | undefined;
}

export interface SanitizedAuditProvenance {
  version: "kab.provenance.v1";
  protocol: AuditInvocationProtocolV1;
  rootCorrelationId: string;
  parentCorrelationId?: string | undefined;
  principal?: SanitizedAuditPrincipalProvenance | undefined;
}

export interface SanitizedAuditEvent {
  version: "kab.audit-event.v1";
  eventId: string;
  tenantId: string;
  installationId: string;
  bridgeInstanceId: string;
  type: AuditEventTypeV1;
  correlationId: string;
  toolId: string;
  actor: string;
  risk: AuditRiskLevelV1;
  occurredAt: string;
  outcome?: AuditPolicyOutcomeV1 | undefined;
  message?: string | undefined;
  provenance?: SanitizedAuditProvenance | undefined;
}

export interface AuditOutboxStore {
  enqueue(event: SanitizedAuditEvent): Promise<void>;
  peek(limit: number): Promise<readonly SanitizedAuditEvent[]>;
  acknowledge(eventIds: readonly string[]): Promise<number>;
  size(): Promise<number>;
}

export class InMemoryAuditOutboxStore implements AuditOutboxStore {
  private readonly events: SanitizedAuditEvent[] = [];

  async enqueue(event: SanitizedAuditEvent): Promise<void> {
    if (this.events.some((candidate) => candidate.eventId === event.eventId)) {
      return;
    }

    this.events.push(structuredClone(event));
  }

  async peek(limit: number): Promise<readonly SanitizedAuditEvent[]> {
    validateLimit(limit);
    return this.events.slice(0, limit).map((event) => structuredClone(event));
  }

  async acknowledge(eventIds: readonly string[]): Promise<number> {
    const ids = new Set(eventIds);
    const before = this.events.length;

    for (let index = this.events.length - 1; index >= 0; index -= 1) {
      if (ids.has(this.events[index]!.eventId)) {
        this.events.splice(index, 1);
      }
    }

    return before - this.events.length;
  }

  async size(): Promise<number> {
    return this.events.length;
  }
}

interface AuditOutboxFileV1 {
  version: "kab.audit-outbox.v1";
  events: SanitizedAuditEvent[];
}

export class FileAuditOutboxStore implements AuditOutboxStore {
  private operation: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async enqueue(event: SanitizedAuditEvent): Promise<void> {
    await this.withLock(async () => {
      const file = await this.loadFile();

      if (file.events.some((candidate) => candidate.eventId === event.eventId)) {
        return;
      }

      file.events.push(structuredClone(event));
      await this.writeFile(file);
    });
  }

  async peek(limit: number): Promise<readonly SanitizedAuditEvent[]> {
    validateLimit(limit);

    return this.withLock(async () => {
      const file = await this.loadFile();
      return file.events.slice(0, limit).map((event) => structuredClone(event));
    });
  }

  async acknowledge(eventIds: readonly string[]): Promise<number> {
    return this.withLock(async () => {
      const ids = new Set(eventIds);
      const file = await this.loadFile();
      const before = file.events.length;
      file.events = file.events.filter((event) => !ids.has(event.eventId));
      const removed = before - file.events.length;

      if (removed > 0) {
        await this.writeFile(file);
      }

      return removed;
    });
  }

  async size(): Promise<number> {
    return this.withLock(async () => (await this.loadFile()).events.length);
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

  private async loadFile(): Promise<AuditOutboxFileV1> {
    try {
      const content = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(content) as AuditOutboxFileV1;

      if (parsed.version !== "kab.audit-outbox.v1" || !Array.isArray(parsed.events)) {
        throw new Error("Audit outbox state is malformed or unsupported.");
      }

      return parsed;
    } catch (error) {
      if (isFileNotFound(error)) {
        return { version: "kab.audit-outbox.v1", events: [] };
      }

      throw error;
    }
  }

  private async writeFile(file: AuditOutboxFileV1): Promise<void> {
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

function validateLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("Audit outbox batch limit must be between 1 and 500.");
  }
}

function isFileNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

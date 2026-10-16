import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { dirname } from "node:path";

import type { A2ATaskState } from "./execution-contracts.js";
import type {
  A2AStoredTask,
  A2ATaskScope,
  A2ATaskStore,
  A2ATaskTransitionClaim,
} from "./task-store.js";

const STORE_SCHEMA_VERSION = "kab.a2a-task-store.v2" as const;
const LEGACY_STORE_SCHEMA_VERSION = "kab.a2a-task-store.v1" as const;
const DEFAULT_MAX_RECORDS = 10_000;
const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024;

interface SerializedA2ATaskEntry {
  record: A2AStoredTask;
  claimId?: string | undefined;
}

interface SerializedA2ATaskStore {
  schemaVersion: typeof STORE_SCHEMA_VERSION;
  records: SerializedA2ATaskEntry[];
}

interface LegacySerializedA2ATaskStore {
  schemaVersion: typeof LEGACY_STORE_SCHEMA_VERSION;
  records: A2AStoredTask[];
}

export interface FileA2ATaskStoreOptions {
  filePath: string;
  maxRecords?: number | undefined;
  maxFileBytes?: number | undefined;
}

/**
 * Durable single-node A2A task storage for production runtimes.
 *
 * Writes are serialized inside one process and committed with an atomic rename.
 * Transition claims are persisted before a resumed action executes; after an
 * uncertain crash, the task remains fail-closed instead of automatically
 * risking a duplicate mutating side effect.
 *
 * This is still not a clustered datastore. Multi-node deployments must provide
 * a shared A2ATaskStore whose claimTransition/completeTransition operations are
 * atomic across every runtime instance.
 */
export class FileA2ATaskStore implements A2ATaskStore {
  private readonly filePath: string;
  private readonly maxRecords: number;
  private readonly maxFileBytes: number;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: FileA2ATaskStoreOptions) {
    if (!options.filePath.trim()) {
      throw new Error("A2A task store filePath must not be empty.");
    }

    this.filePath = options.filePath;
    this.maxRecords = normalizePositiveInteger(
      options.maxRecords ?? DEFAULT_MAX_RECORDS,
      "maxRecords",
    );
    this.maxFileBytes = normalizePositiveInteger(
      options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
      "maxFileBytes",
    );
  }

  async save(record: A2AStoredTask): Promise<void> {
    return this.enqueue(async () => {
      const store = await this.readStore();
      const index = store.records.findIndex(
        (candidate) => candidate.record.task.id === record.task.id,
      );
      const existing = index >= 0 ? store.records[index] : undefined;

      if (existing && !sameScope(existing.record.scope, record.scope)) {
        throw new Error("A2A task ID collision across security scopes.");
      }
      if (existing?.claimId) {
        throw new Error("A2A task has an active transition claim.");
      }
      if (!existing && store.records.length >= this.maxRecords) {
        throw new Error("A2A durable task store record limit exceeded.");
      }

      const next: SerializedA2ATaskEntry = { record: cloneRecord(record) };
      if (index >= 0) {
        store.records[index] = next;
      } else {
        store.records.push(next);
      }
      sortEntries(store.records);
      await this.writeStore(store);
    });
  }

  async get(
    taskId: string,
    scope: A2ATaskScope,
  ): Promise<A2AStoredTask | null> {
    await this.queue;
    const store = await this.readStore();
    const entry = store.records.find(
      (candidate) => candidate.record.task.id === taskId,
    );
    if (!entry || !sameScope(entry.record.scope, scope)) {
      return null;
    }
    return cloneRecord(entry.record);
  }

  async claimTransition(
    taskId: string,
    scope: A2ATaskScope,
    expectedState: A2ATaskState,
    claimId: string = randomUUID(),
  ): Promise<A2ATaskTransitionClaim | null> {
    validateClaimId(claimId);
    let claim: A2ATaskTransitionClaim | null = null;

    await this.enqueue(async () => {
      const store = await this.readStore();
      const entry = store.records.find(
        (candidate) => candidate.record.task.id === taskId,
      );
      if (
        !entry ||
        !sameScope(entry.record.scope, scope) ||
        entry.claimId ||
        entry.record.task.status.state !== expectedState
      ) {
        return;
      }

      const original = cloneRecord(entry.record);
      entry.claimId = claimId;
      entry.record = markWorking(entry.record);
      await this.writeStore(store);
      claim = { claimId, record: original };
    });

    return claim;
  }

  async completeTransition(
    claim: A2ATaskTransitionClaim,
    record: A2AStoredTask,
  ): Promise<boolean> {
    validateClaimId(claim.claimId);
    if (record.task.id !== claim.record.task.id) {
      throw new Error("A2A transition completion task ID mismatch.");
    }
    if (!sameScope(record.scope, claim.record.scope)) {
      throw new Error("A2A transition completion scope mismatch.");
    }

    let completed = false;
    await this.enqueue(async () => {
      const store = await this.readStore();
      const index = store.records.findIndex(
        (candidate) => candidate.record.task.id === record.task.id,
      );
      const entry = index >= 0 ? store.records[index] : undefined;
      if (
        !entry ||
        entry.claimId !== claim.claimId ||
        !sameScope(entry.record.scope, record.scope)
      ) {
        return;
      }

      store.records[index] = { record: cloneRecord(record) };
      await this.writeStore(store);
      completed = true;
    });
    return completed;
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async readStore(): Promise<SerializedA2ATaskStore> {
    try {
      const info = await lstat(this.filePath);
      if (info.isSymbolicLink()) {
        throw new Error("A2A durable task store must not be a symbolic link.");
      }
      if (!info.isFile()) {
        throw new Error("A2A durable task store path is not a regular file.");
      }
      if (info.size > this.maxFileBytes) {
        throw new Error("A2A durable task store exceeds the configured size limit.");
      }
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        return emptyStore();
      }
      throw error;
    }

    const raw = await readFile(this.filePath, "utf8");
    if (Buffer.byteLength(raw, "utf8") > this.maxFileBytes) {
      throw new Error("A2A durable task store exceeds the configured size limit.");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw new Error("A2A durable task store is corrupt.");
    }

    return validateStore(parsed, this.maxRecords);
  }

  private async writeStore(store: SerializedA2ATaskStore): Promise<void> {
    const payload = `${JSON.stringify(store, null, 2)}\n`;
    if (Buffer.byteLength(payload, "utf8") > this.maxFileBytes) {
      throw new Error("A2A durable task store exceeds the configured size limit.");
    }

    const directory = dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });

    const tempPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(tempPath, "wx", 0o600);
      await handle.writeFile(payload, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(tempPath, this.filePath);
    } catch (error) {
      if (handle) {
        await handle.close().catch(() => undefined);
      }
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

function emptyStore(): SerializedA2ATaskStore {
  return {
    schemaVersion: STORE_SCHEMA_VERSION,
    records: [],
  };
}

function validateStore(
  value: unknown,
  maxRecords: number,
): SerializedA2ATaskStore {
  if (!isPlainObject(value)) {
    throw new Error("A2A durable task store schema is invalid or unsupported.");
  }

  if (value.schemaVersion === LEGACY_STORE_SCHEMA_VERSION) {
    return migrateLegacyStore(value, maxRecords);
  }
  if (value.schemaVersion !== STORE_SCHEMA_VERSION) {
    throw new Error("A2A durable task store schema is invalid or unsupported.");
  }
  if (!Array.isArray(value.records) || value.records.length > maxRecords) {
    throw new Error("A2A durable task store record set is invalid.");
  }

  const taskIds = new Set<string>();
  const records = value.records.map((entry) => {
    if (!isPlainObject(entry) || !isStoredTask(entry.record)) {
      throw new Error("A2A durable task store contains an invalid record.");
    }
    if (entry.claimId !== undefined) validateClaimIdValue(entry.claimId);
    if (taskIds.has(entry.record.task.id)) {
      throw new Error("A2A durable task store contains duplicate task IDs.");
    }
    taskIds.add(entry.record.task.id);
    return {
      record: cloneRecord(entry.record),
      ...(entry.claimId !== undefined ? { claimId: entry.claimId } : {}),
    };
  });

  return { schemaVersion: STORE_SCHEMA_VERSION, records };
}

function migrateLegacyStore(
  value: Record<string, unknown>,
  maxRecords: number,
): SerializedA2ATaskStore {
  if (!Array.isArray(value.records) || value.records.length > maxRecords) {
    throw new Error("A2A durable task store record set is invalid.");
  }

  const taskIds = new Set<string>();
  const records = value.records.map((record) => {
    if (!isStoredTask(record)) {
      throw new Error("A2A durable task store contains an invalid record.");
    }
    if (taskIds.has(record.task.id)) {
      throw new Error("A2A durable task store contains duplicate task IDs.");
    }
    taskIds.add(record.task.id);
    return { record: cloneRecord(record) };
  });
  return { schemaVersion: STORE_SCHEMA_VERSION, records };
}

function isStoredTask(value: unknown): value is A2AStoredTask {
  if (!isPlainObject(value)) return false;
  const { task, scope, invocation } = value;
  return (
    isPlainObject(task) &&
    typeof task.id === "string" &&
    task.id.length > 0 &&
    isPlainObject(task.status) &&
    typeof task.status.state === "string" &&
    isScope(scope) &&
    isPlainObject(invocation) &&
    typeof invocation.toolId === "string" &&
    invocation.toolId.length > 0 &&
    typeof invocation.correlationId === "string" &&
    invocation.correlationId.length > 0 &&
    typeof invocation.actionFingerprint === "string" &&
    invocation.actionFingerprint.length > 0 &&
    Object.prototype.hasOwnProperty.call(invocation, "input")
  );
}

function isScope(value: unknown): value is A2ATaskScope {
  return (
    isPlainObject(value) &&
    typeof value.actor === "string" &&
    value.actor.length > 0 &&
    typeof value.tenantId === "string" &&
    value.tenantId.length > 0 &&
    typeof value.installationId === "string" &&
    value.installationId.length > 0
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function sameScope(left: A2ATaskScope, right: A2ATaskScope): boolean {
  return (
    left.actor === right.actor &&
    left.tenantId === right.tenantId &&
    left.installationId === right.installationId
  );
}

function markWorking(record: A2AStoredTask): A2AStoredTask {
  const next = cloneRecord(record);
  next.task.status = { ...next.task.status, state: "TASK_STATE_WORKING" };
  return next;
}

function cloneRecord(record: A2AStoredTask): A2AStoredTask {
  return structuredClone(record);
}

function sortEntries(records: SerializedA2ATaskEntry[]): void {
  records.sort((left, right) =>
    left.record.task.id.localeCompare(right.record.task.id),
  );
}

function validateClaimId(value: string): void {
  validateClaimIdValue(value);
}

function validateClaimIdValue(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 256 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error("A2A transition claim ID is invalid.");
  }
}

function normalizePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`A2A task store ${name} must be a positive safe integer.`);
  }
  return value;
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

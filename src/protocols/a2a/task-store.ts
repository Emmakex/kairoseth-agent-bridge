import type { A2ATask } from "./execution-contracts.js";

export interface A2ATaskScope {
  actor: string;
  tenantId: string;
  installationId: string;
}

export interface A2AStoredInvocation {
  toolId: string;
  input: unknown;
  correlationId: string;
  actionFingerprint: string;
}

export interface A2AStoredTask {
  task: A2ATask;
  scope: A2ATaskScope;
  invocation: A2AStoredInvocation;
}

export interface A2ATaskStore {
  save(record: A2AStoredTask): Promise<void>;
  get(taskId: string, scope: A2ATaskScope): Promise<A2AStoredTask | null>;
}

/**
 * Baseline store for tests, local/dev and embedders that provide their own
 * durable store later. It always applies exact actor + tenant + installation
 * scope matching before returning a task, so task IDs never act as bearer
 * credentials.
 */
export class InMemoryA2ATaskStore implements A2ATaskStore {
  private readonly records = new Map<string, A2AStoredTask>();

  async save(record: A2AStoredTask): Promise<void> {
    const existing = this.records.get(record.task.id);
    if (existing && !sameScope(existing.scope, record.scope)) {
      throw new Error("A2A task ID collision across security scopes.");
    }

    this.records.set(record.task.id, cloneRecord(record));
  }

  async get(
    taskId: string,
    scope: A2ATaskScope,
  ): Promise<A2AStoredTask | null> {
    const record = this.records.get(taskId);
    if (!record || !sameScope(record.scope, scope)) {
      return null;
    }

    return cloneRecord(record);
  }
}

function sameScope(left: A2ATaskScope, right: A2ATaskScope): boolean {
  return (
    left.actor === right.actor &&
    left.tenantId === right.tenantId &&
    left.installationId === right.installationId
  );
}

function cloneRecord(record: A2AStoredTask): A2AStoredTask {
  return structuredClone(record);
}

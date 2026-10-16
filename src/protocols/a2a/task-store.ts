import { randomUUID } from "node:crypto";

import type { InvocationProvenance } from "../../core/contracts.js";
import type { A2ATask, A2ATaskState } from "./execution-contracts.js";

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
  provenance?: InvocationProvenance | undefined;
}

export interface A2AStoredTask {
  task: A2ATask;
  scope: A2ATaskScope;
  invocation: A2AStoredInvocation;
}

export interface A2ATaskTransitionClaim {
  claimId: string;
  record: A2AStoredTask;
}

/**
 * Task stores must make claim/complete atomic for one task ID.
 *
 * Clustered/shared implementations must persist the claim in the shared
 * datastore. Claims intentionally have no automatic expiry: after an
 * uncertain crash, retry remains fail-closed until an operator reconciles the
 * task rather than risking a duplicate mutating side effect.
 */
export interface A2ATaskStore {
  save(record: A2AStoredTask): Promise<void>;
  get(taskId: string, scope: A2ATaskScope): Promise<A2AStoredTask | null>;
  claimTransition(
    taskId: string,
    scope: A2ATaskScope,
    expectedState: A2ATaskState,
    claimId?: string,
  ): Promise<A2ATaskTransitionClaim | null>;
  completeTransition(
    claim: A2ATaskTransitionClaim,
    record: A2AStoredTask,
  ): Promise<boolean>;
}

interface InMemoryEntry {
  record: A2AStoredTask;
  claimId?: string | undefined;
}

export class InMemoryA2ATaskStore implements A2ATaskStore {
  private readonly records = new Map<string, InMemoryEntry>();

  async save(record: A2AStoredTask): Promise<void> {
    const existing = this.records.get(record.task.id);
    if (existing && !sameScope(existing.record.scope, record.scope)) {
      throw new Error("A2A task ID collision across security scopes.");
    }
    if (existing?.claimId) {
      throw new Error("A2A task has an active transition claim.");
    }
    this.records.set(record.task.id, { record: cloneRecord(record) });
  }

  async get(taskId: string, scope: A2ATaskScope): Promise<A2AStoredTask | null> {
    const entry = this.records.get(taskId);
    if (!entry || !sameScope(entry.record.scope, scope)) return null;
    return cloneRecord(entry.record);
  }

  async claimTransition(
    taskId: string,
    scope: A2ATaskScope,
    expectedState: A2ATaskState,
    claimId: string = randomUUID(),
  ): Promise<A2ATaskTransitionClaim | null> {
    validateClaimId(claimId);
    const entry = this.records.get(taskId);
    if (
      !entry ||
      !sameScope(entry.record.scope, scope) ||
      entry.claimId ||
      entry.record.task.status.state !== expectedState
    ) {
      return null;
    }

    const original = cloneRecord(entry.record);
    entry.claimId = claimId;
    entry.record = markWorking(entry.record);
    return { claimId, record: original };
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

    const entry = this.records.get(record.task.id);
    if (
      !entry ||
      entry.claimId !== claim.claimId ||
      !sameScope(entry.record.scope, record.scope)
    ) {
      return false;
    }

    this.records.set(record.task.id, { record: cloneRecord(record) });
    return true;
  }
}

export function sameA2ATaskScope(
  left: A2ATaskScope,
  right: A2ATaskScope,
): boolean {
  return sameScope(left, right);
}

function markWorking(record: A2AStoredTask): A2AStoredTask {
  const next = cloneRecord(record);
  next.task.status = {
    ...next.task.status,
    state: "TASK_STATE_WORKING",
  };
  return next;
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

function validateClaimId(value: string): void {
  if (!value.trim() || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("A2A transition claim ID is invalid.");
  }
}

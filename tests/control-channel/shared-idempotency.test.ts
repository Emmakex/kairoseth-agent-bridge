import assert from "node:assert/strict";
import test from "node:test";

import {
  BridgeRuntime,
  CommandProcessor,
  InMemoryApprovalReplayStore,
  InMemoryCommandReceiptStore,
  ToolRegistry,
  createActionFingerprint,
  type ApprovalReplayRecord,
  type CommandEnvelope,
  type PolicyEvaluator,
  type SessionCredential,
} from "../../src/index.js";

const NOW = new Date("2026-10-14T09:00:00.000Z");

const credential: SessionCredential = {
  version: "kab.session-credential.v1",
  sessionId: "session-shared",
  tenantId: "tenant-1",
  installationId: "installation-1",
  bridgeInstanceId: "bridge-1",
  keyId: "key-1",
  accessToken: "not-used-by-processor",
  issuedAt: "2026-10-14T08:59:00.000Z",
  expiresAt: "2026-10-14T10:00:00.000Z",
  heartbeatIntervalSeconds: 15,
};

const allowPolicy: PolicyEvaluator = {
  async evaluate() {
    return { outcome: "ALLOW", reason: "test allow" };
  },
};

function commandFor(input: unknown, overrides: Partial<CommandEnvelope> = {}): CommandEnvelope {
  const fingerprintInput = {
    tenantId: credential.tenantId,
    installationId: credential.installationId,
    toolId: "shared.write",
    correlationId: "corr-shared",
    input,
  };
  return {
    version: "kab.command.v1",
    commandId: "shared-command-1",
    deliveryAttempt: 1,
    tenantId: credential.tenantId,
    installationId: credential.installationId,
    bridgeInstanceId: credential.bridgeInstanceId,
    correlationId: "corr-shared",
    actor: "agent:shared",
    toolId: "shared.write",
    input,
    actionFingerprint: createActionFingerprint(fingerprintInput),
    issuedAt: "2026-10-14T08:59:30.000Z",
    expiresAt: "2026-10-14T09:10:00.000Z",
    ...overrides,
  };
}

test("atomic command claim prevents two runtime instances from executing the same command", async () => {
  const receipts = new InMemoryCommandReceiptStore();
  const registry = new ToolRegistry();
  let executions = 0;
  let releaseExecution: (() => void) | undefined;
  let signalStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseExecution = resolve;
  });

  registry.register({
    id: "shared.write",
    name: "Shared write",
    description: "Shared idempotency test tool",
    risk: "WRITE",
    async execute() {
      executions += 1;
      signalStarted?.();
      await release;
      return { ok: true };
    },
  });

  const runtime = new BridgeRuntime({ registry, policy: allowPolicy });
  const first = new CommandProcessor(runtime, receipts, { now: () => NOW });
  const second = new CommandProcessor(runtime, receipts, { now: () => NOW });
  const command = commandFor({ orderId: 42, state: "processing" });

  const firstResultPromise = first.process(command, credential);
  await started;

  const secondResult = await second.process(
    { ...command, deliveryAttempt: 2 },
    credential,
  );
  assert.equal(secondResult.status, "indeterminate");
  assert.equal(executions, 1);

  releaseExecution?.();
  const firstResult = await firstResultPromise;
  assert.equal(firstResult.status, "executed");
  assert.equal(executions, 1);

  const third = new CommandProcessor(runtime, receipts, { now: () => NOW });
  const thirdResult = await third.process(
    { ...command, deliveryAttempt: 3 },
    credential,
  );
  assert.equal(thirdResult.status, "duplicate");
  assert.equal(thirdResult.originalOutcome, "executed");
  assert.equal(executions, 1);
});

test("atomic claim rejects same command ID with a different fingerprint while original is processing", async () => {
  const receipts = new InMemoryCommandReceiptStore();
  const registry = new ToolRegistry();
  let executions = 0;
  let releaseExecution: (() => void) | undefined;
  let signalStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseExecution = resolve;
  });

  registry.register({
    id: "shared.write",
    name: "Shared write",
    description: "Shared idempotency test tool",
    risk: "WRITE",
    async execute() {
      executions += 1;
      signalStarted?.();
      await release;
      return { ok: true };
    },
  });

  const runtime = new BridgeRuntime({ registry, policy: allowPolicy });
  const original = commandFor({ value: 1 });
  const firstResult = new CommandProcessor(runtime, receipts, { now: () => NOW }).process(
    original,
    credential,
  );
  await started;

  const changedInput = { value: 2 };
  const changed = commandFor(changedInput, {
    deliveryAttempt: 2,
    actionFingerprint: createActionFingerprint({
      tenantId: credential.tenantId,
      installationId: credential.installationId,
      toolId: "shared.write",
      correlationId: "corr-shared",
      input: changedInput,
    }),
  });
  const collision = await new CommandProcessor(runtime, receipts, { now: () => NOW }).process(
    changed,
    credential,
  );

  assert.equal(collision.status, "rejected");
  assert.match(collision.reason ?? "", /different action fingerprint/i);
  assert.equal(executions, 1);

  releaseExecution?.();
  assert.equal((await firstResult).status, "executed");
  assert.equal(executions, 1);
});

test("receipt completion is compare-and-set and cannot overwrite another fingerprint", async () => {
  const receipts = new InMemoryCommandReceiptStore();
  const processing = {
    version: "kab.command-receipt.v1" as const,
    commandId: "cmd-1",
    actionFingerprint: "fingerprint-a",
    state: "processing" as const,
    startedAt: NOW.toISOString(),
    retainUntil: "2026-10-15T09:00:00.000Z",
  };
  assert.equal((await receipts.claim(processing)).claimed, true);

  await assert.rejects(
    () =>
      receipts.complete({
        version: "kab.command-receipt.v1",
        commandId: "cmd-1",
        actionFingerprint: "fingerprint-b",
        state: "completed",
        startedAt: NOW.toISOString(),
        completedAt: NOW.toISOString(),
        retainUntil: "2026-10-15T09:00:00.000Z",
        outcome: "executed",
      }),
    /different action fingerprint/i,
  );
});

test("approval replay consume remains single-winner under concurrent callers", async () => {
  const store = new InMemoryApprovalReplayStore();
  const record: ApprovalReplayRecord = {
    version: "kab.approval-replay.v1",
    nonce: "nonce-shared-1",
    tenantId: "tenant-1",
    installationId: "installation-1",
    toolId: "shared.write",
    correlationId: "corr-shared",
    actionFingerprint: "fingerprint-1",
    consumedAt: NOW.toISOString(),
    retainUntil: "2026-10-15T09:00:00.000Z",
  };

  const results = await Promise.all(
    Array.from({ length: 20 }, () => store.consume(record)),
  );
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(results.filter((value) => !value).length, 19);
});

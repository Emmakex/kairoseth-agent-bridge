import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BridgeRuntime,
  CommandDeliveryClient,
  CommandProcessor,
  ControlSession,
  FileCommandReceiptStore,
  InMemoryCommandReceiptStore,
  ToolRegistry,
  createActionFingerprint,
  type CommandEnvelope,
  type OutboundCommandTransport,
  type OutboundSessionTransport,
  type PolicyEvaluator,
  type SessionCredential,
} from "../../src/index.js";

const NOW = new Date("2026-10-13T14:30:00.000Z");

const allowPolicy: PolicyEvaluator = {
  async evaluate() {
    return { outcome: "ALLOW", reason: "Allowed by test policy." };
  },
};

const sessionCredential: SessionCredential = {
  version: "kab.session-credential.v1",
  sessionId: "session-1",
  tenantId: "tenant-1",
  installationId: "installation-1",
  bridgeInstanceId: "bridge-1",
  keyId: "key-1",
  accessToken: "secret-session-token",
  issuedAt: "2026-10-13T14:29:00.000Z",
  expiresAt: "2026-10-13T15:00:00.000Z",
  heartbeatIntervalSeconds: 15,
};

const unusedSessionTransport: OutboundSessionTransport = {
  async requestSessionChallenge() {
    throw new Error("not used");
  },
  async openSession() {
    throw new Error("not used");
  },
  async sendHeartbeat() {
    throw new Error("not used");
  },
};

function createSession(): ControlSession {
  return new ControlSession(sessionCredential, unusedSessionTransport, {
    runtimeVersion: "0.1.0",
    now: () => NOW,
  });
}

function commandFor(
  input: unknown,
  overrides: Partial<CommandEnvelope> = {},
): CommandEnvelope {
  const base = {
    tenantId: sessionCredential.tenantId,
    installationId: sessionCredential.installationId,
    toolId: "orders.update",
    correlationId: "corr-1",
    input,
  };

  return {
    version: "kab.command.v1",
    commandId: "command-1",
    deliveryAttempt: 1,
    tenantId: base.tenantId,
    installationId: base.installationId,
    bridgeInstanceId: sessionCredential.bridgeInstanceId,
    correlationId: base.correlationId,
    actor: "agent-1",
    toolId: base.toolId,
    input,
    actionFingerprint: createActionFingerprint(base),
    issuedAt: "2026-10-13T14:29:30.000Z",
    expiresAt: "2026-10-13T14:40:00.000Z",
    ...overrides,
  };
}

function createRuntime(onExecute: () => void): BridgeRuntime {
  const registry = new ToolRegistry();
  registry.register({
    id: "orders.update",
    name: "Update order",
    description: "Mutation used by command delivery tests",
    risk: "WRITE",
    async execute(input) {
      onExecute();
      return { updated: true, input };
    },
  });

  return new BridgeRuntime({ registry, policy: allowPolicy });
}

test("lost ACK does not re-execute a completed command after runtime restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kab-command-"));
  const receiptPath = join(directory, "receipts.json");
  let executions = 0;
  let fetchAttempt = 0;
  const command = commandFor({ orderId: 42, status: "processing" });

  try {
    const runtime = createRuntime(() => {
      executions += 1;
    });

    const firstTransport: OutboundCommandTransport = {
      async fetchCommands() {
        fetchAttempt += 1;
        return {
          version: "kab.command-batch.v1",
          batchId: "batch-1",
          sessionId: sessionCredential.sessionId,
          commands: [command],
        };
      },
      async acknowledgeCommand() {
        throw new Error("connection dropped before ACK");
      },
    };

    const firstProcessor = new CommandProcessor(
      runtime,
      new FileCommandReceiptStore(receiptPath),
      { now: () => NOW },
    );
    const firstDelivery = new CommandDeliveryClient(
      createSession(),
      firstTransport,
      firstProcessor,
    );

    await assert.rejects(
      () => firstDelivery.drainOnce(),
      /connection dropped before ACK/,
    );
    assert.equal(executions, 1);

    let duplicateAckStatus: string | null = null;
    let duplicateOriginalOutcome: string | undefined;

    const retryTransport: OutboundCommandTransport = {
      async fetchCommands() {
        fetchAttempt += 1;
        return {
          version: "kab.command-batch.v1",
          batchId: "batch-2",
          sessionId: sessionCredential.sessionId,
          commands: [{ ...command, deliveryAttempt: 2 }],
        };
      },
      async acknowledgeCommand(_accessToken, acknowledgement) {
        duplicateAckStatus = acknowledgement.status;
        duplicateOriginalOutcome = acknowledgement.originalOutcome;
      },
    };

    const restartedProcessor = new CommandProcessor(
      runtime,
      new FileCommandReceiptStore(receiptPath),
      { now: () => NOW },
    );
    const restartedDelivery = new CommandDeliveryClient(
      createSession(),
      retryTransport,
      restartedProcessor,
    );

    await restartedDelivery.drainOnce();

    assert.equal(fetchAttempt, 2);
    assert.equal(executions, 1);
    assert.equal(duplicateAckStatus, "duplicate");
    assert.equal(duplicateOriginalOutcome, "executed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("processing receipt blocks automatic re-execution after an uncertain crash", async () => {
  let executions = 0;
  const runtime = createRuntime(() => {
    executions += 1;
  });
  const receipts = new InMemoryCommandReceiptStore();
  const command = commandFor({ orderId: 42 });

  await receipts.save({
    version: "kab.command-receipt.v1",
    commandId: command.commandId,
    actionFingerprint: command.actionFingerprint,
    state: "processing",
    startedAt: "2026-10-13T14:29:50.000Z",
    retainUntil: "2026-10-14T14:30:00.000Z",
  });

  const processor = new CommandProcessor(runtime, receipts, { now: () => NOW });
  const acknowledgement = await processor.process(command, sessionCredential);

  assert.equal(acknowledgement.status, "indeterminate");
  assert.equal(executions, 0);
});

test("command ID reuse with a different action fingerprint is rejected", async () => {
  let executions = 0;
  const runtime = createRuntime(() => {
    executions += 1;
  });
  const receipts = new InMemoryCommandReceiptStore();
  const original = commandFor({ orderId: 42, status: "processing" });

  await receipts.save({
    version: "kab.command-receipt.v1",
    commandId: original.commandId,
    actionFingerprint: original.actionFingerprint,
    state: "completed",
    startedAt: NOW.toISOString(),
    completedAt: NOW.toISOString(),
    retainUntil: "2026-10-14T14:30:00.000Z",
    outcome: "executed",
  });

  const changedInput = { orderId: 42, status: "cancelled" };
  const changed = commandFor(changedInput, {
    actionFingerprint: createActionFingerprint({
      tenantId: sessionCredential.tenantId,
      installationId: sessionCredential.installationId,
      toolId: "orders.update",
      correlationId: "corr-1",
      input: changedInput,
    }),
  });

  const acknowledgement = await new CommandProcessor(runtime, receipts, {
    now: () => NOW,
  }).process(changed, sessionCredential);

  assert.equal(acknowledgement.status, "rejected");
  assert.match(acknowledgement.reason ?? "", /reused/);
  assert.equal(executions, 0);
});

test("command with invalid session scope is rejected before execution", async () => {
  let executions = 0;
  const runtime = createRuntime(() => {
    executions += 1;
  });
  const command = commandFor({ orderId: 42 }, { tenantId: "other-tenant" });

  const acknowledgement = await new CommandProcessor(
    runtime,
    new InMemoryCommandReceiptStore(),
    { now: () => NOW },
  ).process(command, sessionCredential);

  assert.equal(acknowledgement.status, "rejected");
  assert.match(acknowledgement.reason ?? "", /scope/);
  assert.equal(executions, 0);
});

test("expired command is recorded and not executed on retry", async () => {
  let executions = 0;
  const runtime = createRuntime(() => {
    executions += 1;
  });
  const receipts = new InMemoryCommandReceiptStore();
  const expired = commandFor(
    { orderId: 42 },
    {
      issuedAt: "2026-10-13T14:00:00.000Z",
      expiresAt: "2026-10-13T14:10:00.000Z",
    },
  );
  const processor = new CommandProcessor(runtime, receipts, { now: () => NOW });

  const first = await processor.process(expired, sessionCredential);
  const retry = await processor.process(
    { ...expired, deliveryAttempt: 2 },
    sessionCredential,
  );

  assert.equal(first.status, "expired");
  assert.equal(retry.status, "duplicate");
  assert.equal(retry.originalOutcome, "expired");
  assert.equal(executions, 0);
});

test("delivery rejects a command batch for another session", async () => {
  const runtime = createRuntime(() => undefined);
  const processor = new CommandProcessor(
    runtime,
    new InMemoryCommandReceiptStore(),
    { now: () => NOW },
  );
  const transport: OutboundCommandTransport = {
    async fetchCommands() {
      return {
        version: "kab.command-batch.v1",
        batchId: "batch-wrong-session",
        sessionId: "different-session",
        commands: [],
      };
    },
    async acknowledgeCommand() {
      throw new Error("must not acknowledge");
    },
  };

  await assert.rejects(
    () => new CommandDeliveryClient(createSession(), transport, processor).drainOnce(),
    /different control session/,
  );
});

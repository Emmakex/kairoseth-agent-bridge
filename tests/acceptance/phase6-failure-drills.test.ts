import assert from "node:assert/strict";
import test from "node:test";

import {
  BridgeRuntime,
  CommandProcessor,
  ConnectorCircuitBreaker,
  ConnectorCircuitOpenError,
  ConnectorRegistryAdapter,
  ConnectorTransientError,
  ControlPlaneRuntimeCoordinator,
  ControlSession,
  InMemoryCommandReceiptStore,
  RuntimeSnapshotScheduler,
  ToolRegistry,
  createActionFingerprint,
  type CommandEnvelope,
  type ConnectorDefinition,
  type ConnectorInstance,
  type OutboundSessionTransport,
  type PolicyEvaluator,
  type RuntimeSnapshotAck,
  type SessionCredential,
} from "../../src/index.js";

const NOW = new Date("2026-10-14T18:20:00.000Z");

const unusedSessionTransport: OutboundSessionTransport = {
  async requestSessionChallenge() {
    throw new Error("unused in failure drill");
  },
  async openSession() {
    throw new Error("unused in failure drill");
  },
  async sendHeartbeat() {
    throw new Error("unused in failure drill");
  },
};

const credential: SessionCredential = {
  version: "kab.session-credential.v1",
  sessionId: "session-drill",
  tenantId: "tenant-drill",
  installationId: "installation-drill",
  bridgeInstanceId: "bridge-drill",
  keyId: "key-drill",
  accessToken: "runtime-token-drill",
  issuedAt: "2026-10-14T18:19:00.000Z",
  expiresAt: "2026-10-14T19:20:00.000Z",
  heartbeatIntervalSeconds: 15,
};

function activeSession(): ControlSession {
  return new ControlSession(credential, unusedSessionTransport, {
    runtimeVersion: "0.1.0-dev.0",
    now: () => NOW,
  });
}

function snapshotAck(snapshotId: string): RuntimeSnapshotAck {
  return {
    version: "kab.runtime-snapshot-ack.v1",
    snapshotId,
    receivedAt: NOW.toISOString(),
  };
}

function untilAborted(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    signal?.addEventListener("abort", () => resolve(), { once: true });
  });
}

const allowPolicy: PolicyEvaluator = {
  async evaluate() {
    return { outcome: "ALLOW", reason: "failure drill allow" };
  },
};

test("drill: transient snapshot outage recovers without taking down the control lifecycle", async () => {
  const external = new AbortController();
  const session = activeSession();
  let reports = 0;
  let sessionExitedAfterAbort = false;
  const errors: string[] = [];
  const sleeps: number[] = [];

  const scheduler = new RuntimeSnapshotScheduler(
    { getCurrentSession: () => session },
    {
      async report(accessToken) {
        assert.equal(accessToken, credential.accessToken);
        reports += 1;
        if (reports === 1) {
          throw new Error("simulated snapshot endpoint outage");
        }
        return snapshotAck("snapshot-recovered");
      },
    },
    {
      intervalMs: 10_000,
      retryInitialDelayMs: 1_000,
      retryMaxDelayMs: 2_000,
      retryMultiplier: 2,
      onError(error) {
        errors.push(error instanceof Error ? error.message : "unknown");
      },
      async sleep(delayMs) {
        sleeps.push(delayMs);
        if (sleeps.length === 2) external.abort();
      },
    },
  );

  const coordinator = new ControlPlaneRuntimeCoordinator(
    {
      async run(readinessProvider, signal) {
        assert.equal(await readinessProvider(), "ready");
        await untilAborted(signal);
        sessionExitedAfterAbort = signal?.aborted ?? false;
      },
    },
    scheduler,
  );

  await coordinator.run(() => "ready", external.signal);

  assert.equal(reports, 2);
  assert.deepEqual(errors, ["simulated snapshot endpoint outage"]);
  assert.deepEqual(sleeps, [1_000, 10_000]);
  assert.equal(sessionExitedAfterAbort, true);
});

test("drill: fatal control-session failure cancels the snapshot loop instead of leaving a half-running runtime", async () => {
  const fatal = new Error("simulated control-session invariant failure");
  let snapshotAborted = false;

  const scheduler = new RuntimeSnapshotScheduler(
    { getCurrentSession: () => null },
    {
      async report() {
        return snapshotAck("unexpected");
      },
    },
    {
      noSessionDelayMs: 1_000,
      async sleep(_delayMs, signal) {
        await untilAborted(signal);
        snapshotAborted = signal?.aborted ?? false;
      },
    },
  );

  const coordinator = new ControlPlaneRuntimeCoordinator(
    {
      async run() {
        throw fatal;
      },
    },
    scheduler,
  );

  await assert.rejects(() => coordinator.run(() => "ready"), fatal);
  assert.equal(snapshotAborted, true);
});

function writeCommand(input: unknown, deliveryAttempt = 1): CommandEnvelope {
  const correlationId = "corr-failure-drill";
  return {
    version: "kab.command.v1",
    commandId: "cmd-failure-drill",
    deliveryAttempt,
    tenantId: credential.tenantId,
    installationId: credential.installationId,
    bridgeInstanceId: credential.bridgeInstanceId,
    correlationId,
    actor: "agent:failure-drill",
    toolId: "drill.write",
    input,
    actionFingerprint: createActionFingerprint({
      tenantId: credential.tenantId,
      installationId: credential.installationId,
      toolId: "drill.write",
      correlationId,
      input,
    }),
    issuedAt: "2026-10-14T18:19:30.000Z",
    expiresAt: "2026-10-14T18:30:00.000Z",
  };
}

test("drill: command redelivery during a mutating side effect never executes the write twice", async () => {
  const receipts = new InMemoryCommandReceiptStore();
  const registry = new ToolRegistry();
  let executions = 0;
  let signalStarted: (() => void) | undefined;
  let releaseExecution: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseExecution = resolve;
  });

  registry.register({
    id: "drill.write",
    name: "Failure drill write",
    description: "Mutating side effect used by the Phase 6 failure drill",
    risk: "WRITE",
    async execute() {
      executions += 1;
      signalStarted?.();
      await release;
      return { ok: true };
    },
  });

  const runtime = new BridgeRuntime({ registry, policy: allowPolicy });
  const firstProcessor = new CommandProcessor(runtime, receipts, { now: () => NOW });
  const secondProcessor = new CommandProcessor(runtime, receipts, { now: () => NOW });
  const command = writeCommand({ orderId: 42, state: "processing" });

  const firstResultPromise = firstProcessor.process(command, credential);
  await started;

  const redeliveryWhileRunning = await secondProcessor.process(
    writeCommand(command.input, 2),
    credential,
  );
  assert.equal(redeliveryWhileRunning.status, "indeterminate");
  assert.equal(executions, 1);

  releaseExecution?.();
  assert.equal((await firstResultPromise).status, "executed");

  const afterCompletion = await new CommandProcessor(runtime, receipts, {
    now: () => NOW,
  }).process(writeCommand(command.input, 3), credential);

  assert.equal(afterCompletion.status, "duplicate");
  assert.equal(afterCompletion.originalOutcome, "executed");
  assert.equal(executions, 1);
});

function drillConnector(executors: {
  failing: ConnectorDefinition["tools"][number]["execute"];
  healthy: ConnectorDefinition["tools"][number]["execute"];
}): ConnectorDefinition {
  return {
    manifest: {
      id: "failure-drill",
      name: "Failure Drill",
      version: "1.0.0",
      description: "Connector isolation failure drill",
      capabilities: ["drill.read"],
      configSchema: { type: "object", additionalProperties: false },
      credentials: [],
    },
    tools: [
      {
        id: "failing.read",
        name: "Failing read",
        description: "Backend deliberately unavailable",
        risk: "READ",
        inputSchema: { type: "object", additionalProperties: false },
        behavior: { retry: { mode: "never" } },
        execute: executors.failing,
      },
      {
        id: "healthy.read",
        name: "Healthy read",
        description: "Healthy sibling operation",
        risk: "READ",
        inputSchema: { type: "object", additionalProperties: false },
        behavior: { retry: { mode: "never" } },
        execute: executors.healthy,
      },
    ],
  };
}

test("drill: a broken backend tool opens only its own circuit and a healthy sibling remains usable", async () => {
  let failingCalls = 0;
  let healthyCalls = 0;
  const breaker = new ConnectorCircuitBreaker({ failureThreshold: 1 });
  const registry = new ToolRegistry();
  const connector = drillConnector({
    async failing() {
      failingCalls += 1;
      throw new ConnectorTransientError("simulated backend outage");
    },
    async healthy() {
      healthyCalls += 1;
      return { ok: true };
    },
  });
  const instance: ConnectorInstance = {
    instanceId: "instance-drill",
    connector,
    config: {},
    secrets: {
      async getSecret() {
        return null;
      },
    },
  };

  new ConnectorRegistryAdapter(registry, { circuitBreaker: breaker }).register(instance);

  const invocation = { correlationId: "corr-breaker-drill", actor: "agent:drill" };
  const failing = registry.get("failure-drill.instance-drill.failing.read")!;
  const healthy = registry.get("failure-drill.instance-drill.healthy.read")!;

  await assert.rejects(() => failing.execute({}, invocation), ConnectorTransientError);
  await assert.rejects(() => failing.execute({}, invocation), ConnectorCircuitOpenError);
  assert.deepEqual(await healthy.execute({}, invocation), { ok: true });
  assert.equal(failingCalls, 1);
  assert.equal(healthyCalls, 1);
});

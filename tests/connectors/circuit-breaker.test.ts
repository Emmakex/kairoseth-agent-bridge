import assert from "node:assert/strict";
import test from "node:test";

import {
  ConnectorCircuitBreaker,
  ConnectorCircuitOpenError,
  ConnectorError,
  ConnectorRegistryAdapter,
  ConnectorTransientError,
  ToolRegistry,
  type ConnectorDefinition,
  type ConnectorInstance,
} from "../../src/index.js";

function definition(executors: {
  primary: ConnectorDefinition["tools"][number]["execute"];
  secondary?: ConnectorDefinition["tools"][number]["execute"];
}): ConnectorDefinition {
  return {
    manifest: {
      id: "breaker-demo",
      name: "Breaker Demo",
      version: "1.0.0",
      description: "Circuit breaker fixture",
      capabilities: ["demo.read"],
      configSchema: { type: "object", additionalProperties: false },
      credentials: [],
    },
    tools: [
      {
        id: "primary.read",
        name: "Primary read",
        description: "Primary breaker tool",
        risk: "READ",
        inputSchema: { type: "object", additionalProperties: false },
        behavior: { retry: { mode: "never" } },
        execute: executors.primary,
      },
      {
        id: "secondary.read",
        name: "Secondary read",
        description: "Secondary breaker tool",
        risk: "READ",
        inputSchema: { type: "object", additionalProperties: false },
        behavior: { retry: { mode: "never" } },
        execute: executors.secondary ?? (async () => ({ ok: true })),
      },
    ],
  };
}

function instance(connector: ConnectorDefinition): ConnectorInstance {
  return {
    instanceId: "instance-1",
    connector,
    config: {},
    secrets: {
      async getSecret() {
        return null;
      },
    },
  };
}

const invocation = { correlationId: "corr-1", actor: "agent-1" };

test("adapter opens circuit after final transient failures and fails fast", async () => {
  let nowMs = Date.parse("2026-10-14T10:00:00.000Z");
  let backendCalls = 0;
  const breaker = new ConnectorCircuitBreaker({
    failureThreshold: 2,
    resetTimeoutMs: 1_000,
    now: () => new Date(nowMs),
  });
  const registry = new ToolRegistry();
  new ConnectorRegistryAdapter(registry, { circuitBreaker: breaker }).register(
    instance(
      definition({
        primary: async () => {
          backendCalls += 1;
          throw new ConnectorTransientError("backend unavailable");
        },
      }),
    ),
  );
  const tool = registry.get("breaker-demo.instance-1.primary.read")!;

  await assert.rejects(() => tool.execute({}, invocation), ConnectorTransientError);
  await assert.rejects(() => tool.execute({}, invocation), ConnectorTransientError);
  assert.equal(backendCalls, 2);

  await assert.rejects(() => tool.execute({}, invocation), ConnectorCircuitOpenError);
  assert.equal(backendCalls, 2);

  const snapshot = breaker.snapshot("breaker-demo:instance-1:primary.read");
  assert.equal(snapshot.state, "open");
  assert.equal(snapshot.consecutiveFailures, 2);

  nowMs += 1_001;
});

test("half-open probe closes the circuit after backend recovery", async () => {
  let nowMs = Date.parse("2026-10-14T10:00:00.000Z");
  let backendCalls = 0;
  let recovered = false;
  const breaker = new ConnectorCircuitBreaker({
    failureThreshold: 1,
    resetTimeoutMs: 1_000,
    now: () => new Date(nowMs),
  });
  const registry = new ToolRegistry();
  new ConnectorRegistryAdapter(registry, { circuitBreaker: breaker }).register(
    instance(
      definition({
        primary: async () => {
          backendCalls += 1;
          if (!recovered) throw new ConnectorTransientError("temporary outage");
          return { ok: true };
        },
      }),
    ),
  );
  const tool = registry.get("breaker-demo.instance-1.primary.read")!;

  await assert.rejects(() => tool.execute({}, invocation), ConnectorTransientError);
  await assert.rejects(() => tool.execute({}, invocation), ConnectorCircuitOpenError);
  assert.equal(backendCalls, 1);

  recovered = true;
  nowMs += 1_001;
  assert.deepEqual(await tool.execute({}, invocation), { ok: true });
  assert.equal(breaker.snapshot("breaker-demo:instance-1:primary.read").state, "closed");

  assert.deepEqual(await tool.execute({}, invocation), { ok: true });
  assert.equal(backendCalls, 3);
});

test("half-open allows only one concurrent backend probe", async () => {
  let nowMs = Date.parse("2026-10-14T10:00:00.000Z");
  let backendCalls = 0;
  let recovered = false;
  let releaseProbe: (() => void) | undefined;
  let signalProbe: (() => void) | undefined;
  const probeStarted = new Promise<void>((resolve) => {
    signalProbe = resolve;
  });
  const probeRelease = new Promise<void>((resolve) => {
    releaseProbe = resolve;
  });
  const breaker = new ConnectorCircuitBreaker({
    failureThreshold: 1,
    resetTimeoutMs: 1_000,
    now: () => new Date(nowMs),
  });
  const registry = new ToolRegistry();
  new ConnectorRegistryAdapter(registry, { circuitBreaker: breaker }).register(
    instance(
      definition({
        primary: async () => {
          backendCalls += 1;
          if (!recovered) throw new ConnectorTransientError("temporary outage");
          signalProbe?.();
          await probeRelease;
          return { ok: true };
        },
      }),
    ),
  );
  const tool = registry.get("breaker-demo.instance-1.primary.read")!;
  await assert.rejects(() => tool.execute({}, invocation), ConnectorTransientError);

  recovered = true;
  nowMs += 1_001;
  const firstProbe = tool.execute({}, invocation);
  await probeStarted;
  await assert.rejects(() => tool.execute({}, invocation), ConnectorCircuitOpenError);
  assert.equal(backendCalls, 2);

  releaseProbe?.();
  assert.deepEqual(await firstProbe, { ok: true });
  assert.equal(breaker.snapshot("breaker-demo:instance-1:primary.read").state, "closed");
});

test("one failing tool circuit does not block another tool in the same connector", async () => {
  let primaryCalls = 0;
  let secondaryCalls = 0;
  const breaker = new ConnectorCircuitBreaker({ failureThreshold: 1 });
  const registry = new ToolRegistry();
  new ConnectorRegistryAdapter(registry, { circuitBreaker: breaker }).register(
    instance(
      definition({
        primary: async () => {
          primaryCalls += 1;
          throw new ConnectorTransientError("primary down");
        },
        secondary: async () => {
          secondaryCalls += 1;
          return { ok: true };
        },
      }),
    ),
  );

  const primary = registry.get("breaker-demo.instance-1.primary.read")!;
  const secondary = registry.get("breaker-demo.instance-1.secondary.read")!;
  await assert.rejects(() => primary.execute({}, invocation), ConnectorTransientError);
  await assert.rejects(() => primary.execute({}, invocation), ConnectorCircuitOpenError);
  assert.deepEqual(await secondary.execute({}, invocation), { ok: true });
  assert.equal(primaryCalls, 1);
  assert.equal(secondaryCalls, 1);
});

test("non-transient connector errors do not open availability circuit", async () => {
  let backendCalls = 0;
  const breaker = new ConnectorCircuitBreaker({ failureThreshold: 1 });
  const registry = new ToolRegistry();
  new ConnectorRegistryAdapter(registry, { circuitBreaker: breaker }).register(
    instance(
      definition({
        primary: async () => {
          backendCalls += 1;
          throw new ConnectorError("business request rejected");
        },
      }),
    ),
  );
  const tool = registry.get("breaker-demo.instance-1.primary.read")!;

  await assert.rejects(() => tool.execute({}, invocation), ConnectorError);
  await assert.rejects(() => tool.execute({}, invocation), ConnectorError);
  assert.equal(backendCalls, 2);
  assert.equal(breaker.snapshot("breaker-demo:instance-1:primary.read").state, "closed");
});

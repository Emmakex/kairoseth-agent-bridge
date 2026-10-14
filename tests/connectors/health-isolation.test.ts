import assert from "node:assert/strict";
import test from "node:test";

import {
  ConnectorCircuitBreaker,
  ConnectorRegistryAdapter,
  ConnectorTransientError,
  ToolRegistry,
  type ConnectorDefinition,
  type ConnectorInstance,
  type ConnectorSecretProvider,
} from "../../src/index.js";

const secrets: ConnectorSecretProvider = {
  async getSecret() {
    return null;
  },
};

function definition(
  health: ConnectorDefinition["health"],
): ConnectorDefinition {
  return {
    manifest: {
      id: "health-fixture",
      name: "Health Fixture",
      version: "1.0.0",
      description: "Connector health isolation fixture",
      capabilities: ["orders.read", "products.read"],
      credentials: [],
    },
    tools: [
      {
        id: "orders.list",
        name: "List orders",
        description: "List fixture orders",
        risk: "READ",
        inputSchema: { type: "object" },
        async execute(_input, context) {
          if (context.config.failOrders === true) {
            throw new ConnectorTransientError("temporary orders backend failure");
          }
          return { ok: true };
        },
      },
      {
        id: "products.list",
        name: "List products",
        description: "List fixture products",
        risk: "READ",
        inputSchema: { type: "object" },
        async execute() {
          return { ok: true };
        },
      },
    ],
    ...(health ? { health } : {}),
  };
}

function instance(
  instanceId: string,
  connector: ConnectorDefinition,
  config: Readonly<Record<string, unknown>> = {},
): ConnectorInstance {
  return {
    instanceId,
    connector,
    config,
    secrets,
  };
}

test("health probe exceptions become isolated unhealthy results without leaking raw error text", async () => {
  const registry = new ToolRegistry();
  const adapter = new ConnectorRegistryAdapter(registry);
  const broken = instance(
    "broken",
    definition(async () => {
      throw new Error("password=do-not-leak");
    }),
  );

  adapter.register(broken);
  const snapshot = await adapter.healthSnapshot(broken);

  assert.equal(snapshot.status, "unhealthy");
  assert.equal(snapshot.probe.status, "unhealthy");
  assert.deepEqual(snapshot.probe.details, { probe: "failed" });
  assert.equal(JSON.stringify(snapshot).includes("do-not-leak"), false);
  assert.equal(snapshot.tools.length, 2);
});

test("hard health timeout returns even when a connector ignores AbortSignal", async () => {
  const registry = new ToolRegistry();
  const adapter = new ConnectorRegistryAdapter(registry, {
    defaultHealthTimeoutMs: 100,
  });
  const hanging = instance(
    "hanging",
    definition(async () => await new Promise<never>(() => undefined)),
  );

  adapter.register(hanging);
  const startedAt = Date.now();
  const snapshot = await adapter.healthSnapshot(hanging);
  const elapsedMs = Date.now() - startedAt;

  assert.equal(snapshot.status, "unhealthy");
  assert.deepEqual(snapshot.probe.details, {
    probe: "timeout",
    timeoutMs: 100,
  });
  assert.ok(elapsedMs < 1_000, `health probe took ${elapsedMs} ms`);
});

test("healthRegistered keeps healthy instances visible when another probe fails", async () => {
  const registry = new ToolRegistry();
  const adapter = new ConnectorRegistryAdapter(registry);
  const connector = definition(async (context) => {
    if (context.config.failHealth === true) {
      throw new Error("backend unavailable");
    }
    return {
      status: "healthy",
      checkedAt: "2026-10-14T10:00:00.000Z",
    };
  });

  adapter.register(instance("z-broken", connector, { failHealth: true }));
  adapter.register(instance("a-healthy", connector));

  const snapshots = await adapter.healthRegistered();

  assert.deepEqual(
    snapshots.map((snapshot) => [snapshot.connectorInstanceId, snapshot.status]),
    [
      ["a-healthy", "healthy"],
      ["z-broken", "unhealthy"],
    ],
  );
});

test("an open tool circuit degrades only its connector instance", async () => {
  const registry = new ToolRegistry();
  const circuitBreaker = new ConnectorCircuitBreaker({
    failureThreshold: 1,
    resetTimeoutMs: 60_000,
  });
  const adapter = new ConnectorRegistryAdapter(registry, {
    circuitBreaker,
  });
  const connector = definition(async () => ({
    status: "healthy",
    checkedAt: "2026-10-14T10:00:00.000Z",
  }));

  adapter.register(instance("shop-bcn", connector, { failOrders: true }));
  adapter.register(instance("shop-madrid", connector));

  await assert.rejects(
    () =>
      registry.get("health-fixture.shop-bcn.orders.list")!.execute(
        {},
        { correlationId: "corr-health-isolation", actor: "agent-1" },
      ),
    (error: unknown) => error instanceof ConnectorTransientError,
  );

  const snapshots = await adapter.healthRegistered();
  const bcn = snapshots.find(
    (snapshot) => snapshot.connectorInstanceId === "shop-bcn",
  );
  const madrid = snapshots.find(
    (snapshot) => snapshot.connectorInstanceId === "shop-madrid",
  );

  assert.ok(bcn);
  assert.ok(madrid);
  assert.equal(bcn.status, "degraded");
  assert.equal(madrid.status, "healthy");
  assert.deepEqual(
    bcn.tools.map((tool) => [tool.toolId, tool.availability]),
    [
      ["orders.list", "blocked"],
      ["products.list", "available"],
    ],
  );
  assert.deepEqual(
    madrid.tools.map((tool) => tool.availability),
    ["available", "available"],
  );
});

test("all blocked tool circuits make only that connector instance unhealthy", async () => {
  const registry = new ToolRegistry();
  const circuitBreaker = new ConnectorCircuitBreaker({
    failureThreshold: 1,
    resetTimeoutMs: 60_000,
  });
  const adapter = new ConnectorRegistryAdapter(registry, { circuitBreaker });
  const connector = definition(async () => ({
    status: "healthy",
    checkedAt: "2026-10-14T10:00:00.000Z",
  }));
  const isolated = instance("isolated", connector, { failOrders: true });

  adapter.register(isolated);
  await assert.rejects(() =>
    registry.get("health-fixture.isolated.orders.list")!.execute(
      {},
      { correlationId: "corr-orders", actor: "agent-1" },
    ),
  );

  circuitBreaker.recordFailure(
    "health-fixture:isolated:products.list",
  );

  const snapshot = await adapter.healthSnapshot(isolated);
  assert.equal(snapshot.status, "unhealthy");
  assert.deepEqual(
    snapshot.tools.map((tool) => tool.availability),
    ["blocked", "blocked"],
  );
});

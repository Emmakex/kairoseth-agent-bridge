import assert from "node:assert/strict";
import test from "node:test";

import {
  ConnectorRegistryAdapter,
  ConnectorTimeoutError,
  ConnectorTransientError,
  ToolRegistry,
  requireConnectorSecret,
  validateConnectorDefinition,
  type ConnectorDefinition,
  type ConnectorInstance,
  type ConnectorSecretProvider,
} from "../../src/index.js";

const secrets: ConnectorSecretProvider = {
  async getSecret(requirementId, fieldId) {
    if (requirementId === "api" && fieldId === "token") {
      return "super-secret-token";
    }
    return null;
  },
};

function connector(overrides: Partial<ConnectorDefinition> = {}): ConnectorDefinition {
  return {
    manifest: {
      id: "demo",
      name: "Demo Connector",
      version: "1.2.3",
      description: "Connector SDK test fixture",
      capabilities: ["orders.read", "orders.write"],
      configSchema: {
        type: "object",
        properties: {
          baseUrl: { type: "string", format: "uri" },
        },
        required: ["baseUrl"],
        additionalProperties: false,
      },
      credentials: [
        {
          id: "api",
          kind: "bearer",
          label: "API access",
          required: true,
          fields: [
            {
              id: "token",
              label: "Token",
              secret: true,
              required: true,
            },
          ],
        },
      ],
    },
    tools: [
      {
        id: "orders.list",
        name: "List orders",
        description: "List orders from the demo system",
        risk: "READ",
        inputSchema: {
          type: "object",
          properties: { limit: { type: "integer", minimum: 1 } },
          additionalProperties: false,
        },
        outputSchema: { type: "array", items: { type: "object" } },
        async execute(input, context) {
          return {
            input,
            connectorId: context.connectorId,
            instanceId: context.connectorInstanceId,
            baseUrl: context.config.baseUrl,
            token: await requireConnectorSecret(context.secrets, "api", "token"),
            actor: context.invocation.actor,
          };
        },
      },
      {
        id: "orders.update",
        name: "Update order",
        description: "Update one order",
        risk: "WRITE",
        inputSchema: {
          type: "object",
          properties: {
            orderId: { type: "integer" },
            idempotencyKey: { type: "string" },
          },
          required: ["orderId", "idempotencyKey"],
        },
        behavior: {
          retry: { mode: "transient", maxAttempts: 3 },
          idempotency: { mode: "keyed", keyField: "idempotencyKey" },
        },
        async execute(input) {
          return input;
        },
      },
    ],
    async health(context) {
      return {
        status: "healthy",
        checkedAt: "2026-10-13T16:30:00.000Z",
        details: {
          hasToken: Boolean(await context.secrets.getSecret("api", "token")),
        },
      };
    },
    ...overrides,
  };
}

function instance(definition = connector()): ConnectorInstance {
  return {
    instanceId: "shop-bcn",
    connector: definition,
    config: { baseUrl: "https://example.test" },
    secrets,
  };
}

test("valid connector definition declares schema, credentials, tools and safe WRITE retries", () => {
  assert.doesNotThrow(() => validateConnectorDefinition(connector()));
});

test("WRITE transient retry without idempotency is rejected", () => {
  const definition = connector({
    tools: [
      {
        id: "dangerous.update",
        name: "Dangerous update",
        description: "Unsafe retry example",
        risk: "WRITE",
        inputSchema: { type: "object" },
        behavior: { retry: { mode: "transient" } },
        async execute() {
          return null;
        },
      },
    ],
  });

  assert.throws(
    () => validateConnectorDefinition(definition),
    /without idempotency/,
  );
});

test("connector tools register with instance-scoped IDs and preserve risk", async () => {
  const registry = new ToolRegistry();
  const adapter = new ConnectorRegistryAdapter(registry);
  const registered = adapter.register(instance());

  assert.deepEqual(registered, {
    connectorId: "demo",
    instanceId: "shop-bcn",
    toolIds: ["demo.shop-bcn.orders.list", "demo.shop-bcn.orders.update"],
  });

  const readTool = registry.get("demo.shop-bcn.orders.list");
  const writeTool = registry.get("demo.shop-bcn.orders.update");
  assert.equal(readTool?.risk, "READ");
  assert.equal(writeTool?.risk, "WRITE");

  const output = await readTool!.execute(
    { limit: 5 },
    { correlationId: "corr-1", actor: "agent-1" },
  );

  assert.deepEqual(output, {
    input: { limit: 5 },
    connectorId: "demo",
    instanceId: "shop-bcn",
    baseUrl: "https://example.test",
    token: "super-secret-token",
    actor: "agent-1",
  });
});

test("two connector instances get separate runtime tool namespaces", () => {
  const registry = new ToolRegistry();
  const adapter = new ConnectorRegistryAdapter(registry);

  adapter.register(instance());
  adapter.register({ ...instance(), instanceId: "shop-madrid" });

  assert.notEqual(
    registry.get("demo.shop-bcn.orders.list"),
    registry.get("demo.shop-madrid.orders.list"),
  );
});

test("registering the same connector instance twice fails on tool conflict", () => {
  const registry = new ToolRegistry();
  const adapter = new ConnectorRegistryAdapter(registry);
  const fixture = instance();

  adapter.register(fixture);
  assert.throws(() => adapter.register(fixture), /already registered/);
});

test("READ transient failures retry only when connector marks them transient", async () => {
  let attempts = 0;
  const definition = connector({
    tools: [
      {
        id: "unstable.read",
        name: "Unstable read",
        description: "Transient retry test",
        risk: "READ",
        inputSchema: { type: "object" },
        behavior: {
          retry: {
            mode: "transient",
            maxAttempts: 3,
            baseDelayMs: 10,
            maxDelayMs: 20,
          },
        },
        async execute() {
          attempts += 1;
          if (attempts < 3) {
            throw new ConnectorTransientError("temporary upstream failure");
          }
          return "ok";
        },
      },
    ],
  });
  const delays: number[] = [];
  const registry = new ToolRegistry();
  const adapter = new ConnectorRegistryAdapter(registry, {
    sleep: async (delayMs) => {
      delays.push(delayMs);
    },
  });
  adapter.register(instance(definition));

  const result = await registry.get("demo.shop-bcn.unstable.read")!.execute(
    {},
    { correlationId: "corr-retry", actor: "agent-1" },
  );

  assert.equal(result, "ok");
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [10, 20]);
});

test("ordinary connector errors are not retried", async () => {
  let attempts = 0;
  const definition = connector({
    tools: [
      {
        id: "ordinary.read",
        name: "Ordinary failure",
        description: "No retry for ordinary error",
        risk: "READ",
        inputSchema: { type: "object" },
        behavior: { retry: { mode: "transient", maxAttempts: 3 } },
        async execute() {
          attempts += 1;
          throw new Error("invalid request");
        },
      },
    ],
  });
  const registry = new ToolRegistry();
  new ConnectorRegistryAdapter(registry, { sleep: async () => undefined }).register(
    instance(definition),
  );

  await assert.rejects(
    () =>
      registry.get("demo.shop-bcn.ordinary.read")!.execute(
        {},
        { correlationId: "corr-no-retry", actor: "agent-1" },
      ),
    /invalid request/,
  );
  assert.equal(attempts, 1);
});

test("tool timeout aborts connector context and raises ConnectorTimeoutError", async () => {
  let observedAbort = false;
  const definition = connector({
    tools: [
      {
        id: "slow.read",
        name: "Slow read",
        description: "Timeout test",
        risk: "READ",
        inputSchema: { type: "object" },
        behavior: { timeoutMs: 100 },
        async execute(_input, context) {
          return await new Promise((_resolve, reject) => {
            context.signal.addEventListener(
              "abort",
              () => {
                observedAbort = true;
                reject(new Error("aborted by runtime"));
              },
              { once: true },
            );
          });
        },
      },
    ],
  });
  const registry = new ToolRegistry();
  new ConnectorRegistryAdapter(registry).register(instance(definition));

  await assert.rejects(
    () =>
      registry.get("demo.shop-bcn.slow.read")!.execute(
        {},
        { correlationId: "corr-timeout", actor: "agent-1" },
      ),
    (error: unknown) => error instanceof ConnectorTimeoutError,
  );
  assert.equal(observedAbort, true);
});

test("health check receives connector config and secret provider", async () => {
  const registry = new ToolRegistry();
  const adapter = new ConnectorRegistryAdapter(registry);
  const health = await adapter.health(instance());

  assert.equal(health.status, "healthy");
  assert.deepEqual(health.details, { hasToken: true });
});

test("required secret accessor fails without exposing a secret value", async () => {
  await assert.rejects(
    () => requireConnectorSecret(secrets, "api", "missing"),
    /api\.missing/,
  );
});

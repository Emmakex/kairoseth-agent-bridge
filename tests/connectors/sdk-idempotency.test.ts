import assert from "node:assert/strict";
import test from "node:test";

import {
  ConnectorError,
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

function instance(connector: ConnectorDefinition): ConnectorInstance {
  return {
    instanceId: "primary",
    connector,
    config: {},
    secrets,
  };
}

test("keyed idempotency is stable across transient retry attempts", async () => {
  const observed: Array<{ attempt: number; key: string | undefined }> = [];

  const connector: ConnectorDefinition = {
    manifest: {
      id: "payments",
      name: "Payments",
      version: "1.0.0",
      description: "Idempotency fixture",
      capabilities: ["payments.write"],
      credentials: [],
    },
    tools: [
      {
        id: "charge.create",
        name: "Create charge",
        description: "Create one charge",
        risk: "WRITE",
        inputSchema: {
          type: "object",
          properties: {
            request: {
              type: "object",
              properties: {
                idempotencyKey: { type: "string" },
              },
              required: ["idempotencyKey"],
            },
          },
          required: ["request"],
        },
        behavior: {
          retry: {
            mode: "transient",
            maxAttempts: 3,
            baseDelayMs: 10,
            maxDelayMs: 20,
          },
          idempotency: {
            mode: "keyed",
            keyField: "request.idempotencyKey",
          },
        },
        async execute(_input, context) {
          observed.push({
            attempt: context.attempt,
            key: context.idempotencyKey,
          });

          if (context.attempt === 1) {
            throw new ConnectorTransientError("temporary upstream failure");
          }

          return { ok: true };
        },
      },
    ],
  };

  const registry = new ToolRegistry();
  new ConnectorRegistryAdapter(registry, {
    sleep: async () => undefined,
  }).register(instance(connector));

  const result = await registry.get("payments.primary.charge.create")!.execute(
    { request: { idempotencyKey: "charge-42" } },
    { correlationId: "corr-idem", actor: "agent-1" },
  );

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(observed, [
    { attempt: 1, key: "charge-42" },
    { attempt: 2, key: "charge-42" },
  ]);
});

test("missing keyed idempotency input fails before connector execution", async () => {
  let executed = false;

  const connector: ConnectorDefinition = {
    manifest: {
      id: "payments",
      name: "Payments",
      version: "1.0.0",
      description: "Idempotency fixture",
      capabilities: ["payments.write"],
      credentials: [],
    },
    tools: [
      {
        id: "charge.create",
        name: "Create charge",
        description: "Create one charge",
        risk: "WRITE",
        inputSchema: { type: "object" },
        behavior: {
          idempotency: {
            mode: "keyed",
            keyField: "request.idempotencyKey",
          },
        },
        async execute() {
          executed = true;
          return { ok: true };
        },
      },
    ],
  };

  const registry = new ToolRegistry();
  new ConnectorRegistryAdapter(registry).register(instance(connector));

  await assert.rejects(
    () =>
      registry.get("payments.primary.charge.create")!.execute(
        { request: {} },
        { correlationId: "corr-missing-idem", actor: "agent-1" },
      ),
    (error: unknown) =>
      error instanceof ConnectorError && /idempotency field/.test(error.message),
  );

  assert.equal(executed, false);
});

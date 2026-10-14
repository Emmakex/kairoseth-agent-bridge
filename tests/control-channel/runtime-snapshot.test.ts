import assert from "node:assert/strict";
import test from "node:test";

import {
  ConnectorRegistryAdapter,
  HttpRuntimeSnapshotTransport,
  RuntimeSnapshotReporter,
  RuntimeSnapshotTransportError,
  ToolRegistry,
  type ConnectorDefinition,
  type ConnectorInstance,
  type ConnectorSecretProvider,
  type RuntimeOperationalSnapshot,
} from "../../src/index.js";

const NOW = new Date("2026-10-14T12:00:00.000Z");

const secrets: ConnectorSecretProvider = {
  async getSecret() {
    return "credential-value-that-must-not-leak";
  },
};

function definition(): ConnectorDefinition {
  return {
    manifest: {
      id: "woocommerce",
      name: "WooCommerce",
      version: "1.0.0",
      description: "WooCommerce connector",
      localizations: {
        es: { name: "WooCommerce", description: "Conector WooCommerce" },
        en: { name: "WooCommerce", description: "WooCommerce connector" },
      },
      capabilities: ["orders"],
      credentials: [],
    },
    tools: [
      {
        id: "orders.list",
        name: "List orders",
        description: "List orders",
        localizations: {
          es: { name: "Listar pedidos", description: "Lista pedidos" },
          en: { name: "List orders", description: "Lists orders" },
        },
        risk: "READ",
        inputSchema: { type: "object", additionalProperties: false },
        async execute() {
          return [];
        },
      },
    ],
    async health() {
      return {
        status: "healthy",
        checkedAt: NOW.toISOString(),
        message: "password=must-not-leak",
        details: { upstreamToken: "must-not-leak" },
      };
    },
  };
}

function instance(): ConnectorInstance {
  return {
    instanceId: "shop-1",
    connector: definition(),
    config: {
      baseUrl: "https://private.customer.example",
      internalPath: "/srv/customer/private",
    },
    secrets,
  };
}

test("runtime reporter combines registered inventory and reduced health without private details", async () => {
  const registry = new ToolRegistry();
  const adapter = new ConnectorRegistryAdapter(registry);
  const configured = instance();
  adapter.register(configured);

  let reported: RuntimeOperationalSnapshot | null = null;
  const reporter = new RuntimeSnapshotReporter(
    [configured],
    adapter,
    {
      async report(accessToken, snapshot) {
        assert.equal(accessToken, "session-secret");
        reported = snapshot;
        return {
          version: "kab.runtime-snapshot-ack.v1",
          snapshotId: snapshot.snapshotId,
          receivedAt: NOW.toISOString(),
        };
      },
    },
    {
      now: () => NOW,
      createSnapshotId: () => "snapshot-1",
    },
  );

  const ack = await reporter.report("session-secret");
  assert.equal(ack.snapshotId, "snapshot-1");
  assert.ok(reported);
  assert.equal(reported.version, "kab.runtime-snapshot.v1");
  assert.equal(reported.connectors[0]?.connectorId, "woocommerce");
  assert.equal(reported.health[0]?.status, "healthy");
  assert.equal(reported.health[0]?.tools[0]?.runtimeToolId, "woocommerce.shop-1.orders.list");

  const serialized = JSON.stringify(reported);
  assert.doesNotMatch(serialized, /password=must-not-leak/);
  assert.doesNotMatch(serialized, /upstreamToken/);
  assert.doesNotMatch(serialized, /private\.customer\.example/);
  assert.doesNotMatch(serialized, /\/srv\/customer\/private/);
  assert.doesNotMatch(serialized, /credential-value-that-must-not-leak/);
  assert.doesNotMatch(serialized, /probe/);
});

test("runtime reporter refuses an inventory that does not match registered instances", async () => {
  const registry = new ToolRegistry();
  const adapter = new ConnectorRegistryAdapter(registry);
  adapter.register(instance());

  const reporter = new RuntimeSnapshotReporter(
    [],
    adapter,
    {
      async report() {
        throw new Error("must not report");
      },
    },
    { now: () => NOW, createSnapshotId: () => "snapshot-mismatch" },
  );

  await assert.rejects(
    () => reporter.build(),
    /must exactly match the connector instances registered/,
  );
});

test("HTTP runtime snapshot transport sends session token only in Authorization", async () => {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const snapshot: RuntimeOperationalSnapshot = {
    version: "kab.runtime-snapshot.v1",
    snapshotId: "snapshot-http-1",
    generatedAt: NOW.toISOString(),
    connectors: [],
    health: [],
  };

  const transport = new HttpRuntimeSnapshotTransport({
    baseUrl: "https://kairoseth.example",
    fetch: async (input, init) => {
      requests.push({ url: String(input), init });
      return new Response(
        JSON.stringify({
          ack: {
            version: "kab.runtime-snapshot-ack.v1",
            snapshotId: "snapshot-http-1",
            receivedAt: NOW.toISOString(),
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  });

  const ack = await transport.report("session-secret-token", snapshot);
  assert.equal(ack.snapshotId, "snapshot-http-1");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url.includes("session-secret-token"), false);
  assert.equal(String(requests[0]?.init?.body).includes("session-secret-token"), false);
  const headers = new Headers(requests[0]?.init?.headers);
  assert.equal(headers.get("authorization"), "Bearer session-secret-token");
  assert.equal(requests[0]?.init?.redirect, "error");
  assert.equal(requests[0]?.init?.cache, "no-store");
});

test("HTTP runtime snapshot transport enforces HTTPS and bounded secret-free errors", async () => {
  assert.throws(
    () =>
      new HttpRuntimeSnapshotTransport({
        baseUrl: "http://customer.example",
      }),
    /requires HTTPS/,
  );
  assert.doesNotThrow(
    () =>
      new HttpRuntimeSnapshotTransport({
        baseUrl: "http://127.0.0.1:3000",
      }),
  );

  const token = "top-secret-session-token";
  const transport = new HttpRuntimeSnapshotTransport({
    baseUrl: "https://kairoseth.example",
    fetch: async () =>
      new Response(
        JSON.stringify({
          code: "invalid_or_expired_session",
          error: `never expose ${token}`,
        }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      ),
  });

  await assert.rejects(
    () =>
      transport.report(token, {
        version: "kab.runtime-snapshot.v1",
        snapshotId: "snapshot-error",
        generatedAt: NOW.toISOString(),
        connectors: [],
        health: [],
      }),
    (error: unknown) => {
      assert.ok(error instanceof RuntimeSnapshotTransportError);
      assert.equal(error.status, 401);
      assert.equal(error.code, "invalid_or_expired_session");
      assert.equal(error.message.includes(token), false);
      assert.equal(error.message.includes("never expose"), false);
      return true;
    },
  );
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  ConnectorError,
  ConnectorRegistryAdapter,
  ToolRegistry,
  createGenericRestConnector,
  validateGenericRestBaseUrl,
  type ConnectorInstance,
  type ConnectorSecretProvider,
  type GenericRestHttpRuntime,
} from "../../src/index.js";

const secrets: ConnectorSecretProvider = {
  async getSecret(requirementId, fieldId) {
    if (requirementId === "auth" && fieldId === "token") return "bearer-secret";
    if (requirementId === "auth" && fieldId === "api_key") return "api-key-secret";
    return null;
  },
};

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

function runtimeWith(
  handler: (request: CapturedRequest, attempt: number) => Response | Promise<Response>,
  addresses: readonly string[] = ["93.184.216.34"],
): { runtime: GenericRestHttpRuntime; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  let attempt = 0;

  return {
    requests,
    runtime: {
      async resolveHost() {
        return addresses;
      },
      async fetch(url, init) {
        attempt += 1;
        const request = { url, init };
        requests.push(request);
        return await handler(request, attempt);
      },
    },
  };
}

function baseConnector(runtime: GenericRestHttpRuntime) {
  return createGenericRestConnector(
    {
      auth: { type: "bearer" },
      operations: [
        {
          id: "orders.get",
          name: "Get order",
          description: "Read one order",
          risk: "READ",
          method: "GET",
          pathTemplate: "/orders/{orderId}",
          query: { expand: "expand" },
          inputSchema: {
            type: "object",
            properties: {
              orderId: { type: "integer" },
              expand: { type: "string" },
            },
            required: ["orderId"],
          },
          outputSchema: { type: "object" },
        },
      ],
    },
    runtime,
  );
}

function connectorInstance(
  connector: ReturnType<typeof createGenericRestConnector>,
  baseUrl = "https://api.example.test/v1",
): ConnectorInstance {
  return {
    instanceId: "customer-api",
    connector,
    config: { baseUrl },
    secrets,
  };
}

test("GET operation maps path/query, injects bearer auth, and redacts sensitive JSON fields", async () => {
  const { runtime, requests } = runtimeWith(() =>
    new Response(
      JSON.stringify({
        id: 42,
        customer: { name: "Ada", access_token: "must-not-leak" },
        password: "also-secret",
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    ),
  );
  const registry = new ToolRegistry();
  new ConnectorRegistryAdapter(registry).register(
    connectorInstance(baseConnector(runtime)),
  );

  const output = await registry.get("generic-rest.customer-api.orders.get")!.execute(
    { orderId: 42, expand: "customer" },
    { correlationId: "corr-rest-1", actor: "agent-1" },
  );

  assert.equal(requests.length, 1);
  assert.equal(
    requests[0]!.url,
    "https://api.example.test/v1/orders/42?expand=customer",
  );
  const headers = new Headers(requests[0]!.init.headers);
  assert.equal(headers.get("authorization"), "Bearer bearer-secret");
  assert.equal(requests[0]!.init.redirect, "manual");
  assert.deepEqual(output, {
    status: 200,
    ok: true,
    body: {
      id: 42,
      customer: { name: "Ada", access_token: "[REDACTED]" },
      password: "[REDACTED]",
    },
  });
});

test("path placeholder is encoded and cannot change request origin", async () => {
  const { runtime, requests } = runtimeWith(() =>
    new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  const registry = new ToolRegistry();
  new ConnectorRegistryAdapter(registry).register(
    connectorInstance(baseConnector(runtime)),
  );

  await registry.get("generic-rest.customer-api.orders.get")!.execute(
    { orderId: "//evil.example/path", expand: null },
    { correlationId: "corr-rest-origin", actor: "agent-1" },
  );

  assert.equal(requests[0]!.url.startsWith("https://api.example.test/"), true);
  assert.match(requests[0]!.url, /%2F%2Fevil\.example%2Fpath/);
});

test("public-only network policy blocks private DNS results before fetch", async () => {
  let fetched = false;
  const { runtime } = runtimeWith(
    () => {
      fetched = true;
      return new Response("{}");
    },
    ["10.20.30.40"],
  );
  const registry = new ToolRegistry();
  new ConnectorRegistryAdapter(registry).register(
    connectorInstance(baseConnector(runtime)),
  );

  await assert.rejects(
    () =>
      registry.get("generic-rest.customer-api.orders.get")!.execute(
        { orderId: 42 },
        { correlationId: "corr-private", actor: "agent-1" },
      ),
    /blocks non-public address/,
  );
  assert.equal(fetched, false);
});

test("local deployment can explicitly allow HTTP and private network", async () => {
  const { runtime, requests } = runtimeWith(
    () =>
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ["192.168.1.20"],
  );
  const connector = createGenericRestConnector(
    {
      network: { allowHttp: true, allowPrivateNetwork: true },
      operations: [
        {
          id: "erp.ping",
          name: "ERP ping",
          description: "Read a local ERP resource",
          risk: "READ",
          method: "GET",
          pathTemplate: "/api/ping",
          inputSchema: { type: "object" },
        },
      ],
    },
    runtime,
  );
  const registry = new ToolRegistry();
  new ConnectorRegistryAdapter(registry).register(
    connectorInstance(connector, "http://192.168.1.20:8080"),
  );

  await registry.get("generic-rest.customer-api.erp.ping")!.execute(
    {},
    { correlationId: "corr-local", actor: "agent-1" },
  );

  assert.equal(requests[0]!.url, "http://192.168.1.20:8080/api/ping");
});

test("exact origin allowlist rejects a different configured origin", async () => {
  const { runtime } = runtimeWith(() => new Response("{}"));

  await assert.rejects(
    () =>
      validateGenericRestBaseUrl(
        "https://other.example.test",
        { allowedOrigins: ["https://api.example.test"] },
        runtime,
      ),
    /not allowlisted/,
  );
});

test("HTTP redirects are blocked and never followed", async () => {
  const { runtime, requests } = runtimeWith(() =>
    new Response(null, {
      status: 302,
      headers: { location: "https://internal.example/secret" },
    }),
  );
  const registry = new ToolRegistry();
  new ConnectorRegistryAdapter(registry).register(
    connectorInstance(baseConnector(runtime)),
  );

  await assert.rejects(
    () =>
      registry.get("generic-rest.customer-api.orders.get")!.execute(
        { orderId: 42 },
        { correlationId: "corr-redirect", actor: "agent-1" },
      ),
    /blocked redirect/,
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.init.redirect, "manual");
});

test("response byte limit rejects oversized responses", async () => {
  const { runtime } = runtimeWith(() =>
    new Response("x".repeat(2048), {
      status: 200,
      headers: { "content-length": "2048", "content-type": "text/plain" },
    }),
  );
  const connector = createGenericRestConnector(
    {
      response: { maxBytes: 1024 },
      operations: [
        {
          id: "data.get",
          name: "Get data",
          description: "Bounded response test",
          risk: "READ",
          method: "GET",
          pathTemplate: "/data",
          inputSchema: { type: "object" },
        },
      ],
    },
    runtime,
  );
  const registry = new ToolRegistry();
  new ConnectorRegistryAdapter(registry).register(connectorInstance(connector));

  await assert.rejects(
    () =>
      registry.get("generic-rest.customer-api.data.get")!.execute(
        {},
        { correlationId: "corr-large", actor: "agent-1" },
      ),
    /exceeds maximum size/,
  );
});

test("transient HTTP status integrates with Connector SDK retry policy", async () => {
  const { runtime, requests } = runtimeWith((_request, attempt) =>
    attempt === 1
      ? new Response("temporary", { status: 503 })
      : new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
  );
  const connector = createGenericRestConnector(
    {
      operations: [
        {
          id: "unstable.read",
          name: "Unstable read",
          description: "Retry a transient HTTP failure",
          risk: "READ",
          method: "GET",
          pathTemplate: "/unstable",
          inputSchema: { type: "object" },
          behavior: {
            retry: {
              mode: "transient",
              maxAttempts: 2,
              baseDelayMs: 10,
              maxDelayMs: 10,
            },
          },
        },
      ],
    },
    runtime,
  );
  const registry = new ToolRegistry();
  new ConnectorRegistryAdapter(registry, { sleep: async () => undefined }).register(
    connectorInstance(connector),
  );

  const output = await registry.get("generic-rest.customer-api.unstable.read")!.execute(
    {},
    { correlationId: "corr-retry-http", actor: "agent-1" },
  );

  assert.equal(requests.length, 2);
  assert.deepEqual(output, { status: 200, ok: true, body: { ok: true } });
});

test("POST operation maps JSON body and API key header without exposing key in config", async () => {
  const { runtime, requests } = runtimeWith(() =>
    new Response(JSON.stringify({ created: true }), {
      status: 201,
      headers: { "content-type": "application/json" },
    }),
  );
  const connector = createGenericRestConnector(
    {
      auth: {
        type: "api_key_header",
        headerName: "X-API-Key",
      },
      operations: [
        {
          id: "tasks.create",
          name: "Create task",
          description: "Create one remote task",
          risk: "WRITE",
          method: "POST",
          pathTemplate: "/tasks",
          body: { source: "field", field: "payload" },
          inputSchema: {
            type: "object",
            properties: {
              payload: { type: "object" },
            },
            required: ["payload"],
          },
        },
      ],
    },
    runtime,
  );
  const registry = new ToolRegistry();
  new ConnectorRegistryAdapter(registry).register(connectorInstance(connector));

  await registry.get("generic-rest.customer-api.tasks.create")!.execute(
    { payload: { title: "Follow up" } },
    { correlationId: "corr-post", actor: "agent-1" },
  );

  const headers = new Headers(requests[0]!.init.headers);
  assert.equal(headers.get("x-api-key"), "api-key-secret");
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(requests[0]!.init.body, JSON.stringify({ title: "Follow up" }));
  assert.deepEqual(connectorInstance(connector).config, {
    baseUrl: "https://api.example.test/v1",
  });
});

test("static headers cannot smuggle Authorization or Host", () => {
  assert.throws(
    () =>
      createGenericRestConnector({
        operations: [
          {
            id: "unsafe.read",
            name: "Unsafe",
            description: "Unsafe static auth header",
            risk: "READ",
            method: "GET",
            pathTemplate: "/data",
            headers: { Authorization: "Bearer embedded-secret" },
            inputSchema: { type: "object" },
          },
        ],
      }),
    /header is not allowed/,
  );
});

test("mutating HTTP methods cannot be classified as READ", () => {
  assert.throws(
    () =>
      createGenericRestConnector({
        operations: [
          {
            id: "unsafe.post",
            name: "Unsafe POST",
            description: "Invalid risk mapping",
            risk: "READ",
            method: "POST",
            pathTemplate: "/write",
            inputSchema: { type: "object" },
          },
        ],
      }),
    /cannot classify POST as READ/,
  );
});

test("health check respects connector network/auth policy", async () => {
  const { runtime, requests } = runtimeWith(() => new Response(null, { status: 204 }));
  const connector = createGenericRestConnector(
    {
      auth: { type: "bearer" },
      healthPath: "/health",
      operations: [
        {
          id: "data.get",
          name: "Get data",
          description: "Fixture operation",
          risk: "READ",
          method: "GET",
          pathTemplate: "/data",
          inputSchema: { type: "object" },
        },
      ],
    },
    runtime,
  );
  const health = await new ConnectorRegistryAdapter(new ToolRegistry()).health(
    connectorInstance(connector),
  );

  assert.equal(health.status, "healthy");
  assert.equal(requests[0]!.url, "https://api.example.test/v1/health");
  assert.equal(
    new Headers(requests[0]!.init.headers).get("authorization"),
    "Bearer bearer-secret",
  );
});

test("non-transient 4xx response raises non-retryable ConnectorError", async () => {
  const { runtime } = runtimeWith(() => new Response("no", { status: 400 }));
  const registry = new ToolRegistry();
  new ConnectorRegistryAdapter(registry).register(
    connectorInstance(baseConnector(runtime)),
  );

  await assert.rejects(
    () =>
      registry.get("generic-rest.customer-api.orders.get")!.execute(
        { orderId: 42 },
        { correlationId: "corr-400", actor: "agent-1" },
      ),
    (error: unknown) => error instanceof ConnectorError && /HTTP 400/.test(error.message),
  );
});

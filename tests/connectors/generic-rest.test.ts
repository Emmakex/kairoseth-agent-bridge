import assert from "node:assert/strict";
import test from "node:test";

import {
  BridgeRuntime,
  ConnectorError,
  ConnectorRegistryAdapter,
  ToolRegistry,
  createGenericRestConnector,
  type ConnectorInstance,
  type ConnectorSecretProvider,
} from "../../src/index.js";

function secretProvider(values: Readonly<Record<string, string>>): ConnectorSecretProvider {
  return {
    async getSecret(requirementId, fieldId) {
      return values[`${requirementId}.${fieldId}`] ?? null;
    },
  };
}

function instance(
  connector: ReturnType<typeof createGenericRestConnector>,
  secrets: ConnectorSecretProvider,
  baseUrl = "https://api.example.test",
): ConnectorInstance {
  return {
    instanceId: "primary",
    connector,
    config: { baseUrl },
    secrets,
  };
}

test("Generic REST exposes a fixed-origin authenticated API as a normalized READ tool", async () => {
  let capturedUrl = "";
  let capturedAuthorization = "";
  let capturedRedirect: RequestRedirect | undefined;

  const fetchImpl: typeof fetch = async (input, init) => {
    capturedUrl = String(input);
    const headers = new Headers(init?.headers);
    capturedAuthorization = headers.get("authorization") ?? "";
    capturedRedirect = init?.redirect;

    return new Response(
      JSON.stringify({
        id: 42,
        access_token: "remote-response-token",
        echoed: "prefix top-secret-token suffix",
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  };

  const connector = createGenericRestConnector({
    fetch: fetchImpl,
    auth: {
      type: "bearer",
      requirementId: "api",
      tokenField: "token",
    },
    endpoints: [
      {
        id: "orders.get",
        name: "Get order",
        description: "Get one order from the external API",
        risk: "READ",
        method: "GET",
        inputSchema: {
          type: "object",
          properties: {
            orderId: { type: "integer" },
            expand: { type: "string" },
          },
          required: ["orderId"],
        },
        request: {
          path: "/v1/orders/{orderId}",
          query: { expand: "expand" },
        },
        outputSchema: { type: "object" },
      },
    ],
  });

  assert.deepEqual(connector.manifest.credentials, [
    {
      id: "api",
      kind: "bearer",
      label: "Bearer authentication",
      required: true,
      fields: [
        {
          id: "token",
          label: "Bearer token",
          secret: true,
          required: true,
        },
      ],
    },
  ]);

  const registry = new ToolRegistry();
  new ConnectorRegistryAdapter(registry).register(
    instance(
      connector,
      secretProvider({ "api.token": "top-secret-token" }),
    ),
  );

  const runtime = new BridgeRuntime({ registry });
  const result = await runtime.invoke(
    "generic-rest.primary.orders.get",
    { orderId: 42, expand: "lines" },
    { correlationId: "corr-rest-read", actor: "agent-1" },
  );

  assert.equal(result.status, "executed");
  if (result.status === "executed") {
    assert.deepEqual(result.output, {
      status: 200,
      body: {
        id: 42,
        access_token: "[REDACTED]",
        echoed: "prefix [REDACTED] suffix",
      },
    });
  }

  assert.equal(capturedUrl, "https://api.example.test/v1/orders/42?expand=lines");
  assert.equal(capturedAuthorization, "Bearer top-secret-token");
  assert.equal(capturedRedirect, "manual");
});

test("path placeholder values cannot change the configured origin", async () => {
  let capturedUrl = "";
  const fetchImpl: typeof fetch = async (input) => {
    capturedUrl = String(input);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const connector = createGenericRestConnector({
    fetch: fetchImpl,
    endpoints: [
      {
        id: "objects.get",
        name: "Get object",
        description: "Path encoding test",
        risk: "READ",
        method: "GET",
        inputSchema: { type: "object" },
        request: { path: "/objects/{objectId}" },
      },
    ],
  });

  const registry = new ToolRegistry();
  new ConnectorRegistryAdapter(registry).register(
    instance(connector, secretProvider({})),
  );

  await registry.get("generic-rest.primary.objects.get")!.execute(
    { objectId: "//evil.example/steal" },
    { correlationId: "corr-path", actor: "agent-1" },
  );

  const url = new URL(capturedUrl);
  assert.equal(url.origin, "https://api.example.test");
  assert.match(url.pathname, /^\/objects\//);
  assert.equal(url.hostname, "api.example.test");
});

test("keyed WRITE retries propagate one stable Idempotency-Key", async () => {
  const observed: Array<{
    idempotencyKey: string | null;
    body: string;
  }> = [];
  let calls = 0;

  const fetchImpl: typeof fetch = async (_input, init) => {
    calls += 1;
    const headers = new Headers(init?.headers);
    observed.push({
      idempotencyKey: headers.get("idempotency-key"),
      body: String(init?.body ?? ""),
    });

    if (calls === 1) {
      return new Response("temporary", { status: 503 });
    }

    return new Response(JSON.stringify({ accepted: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const connector = createGenericRestConnector({
    fetch: fetchImpl,
    endpoints: [
      {
        id: "orders.update",
        name: "Update order",
        description: "Update one order through an idempotent API",
        risk: "WRITE",
        method: "PATCH",
        inputSchema: {
          type: "object",
          properties: {
            orderId: { type: "integer" },
            requestId: { type: "string" },
            payload: { type: "object" },
          },
          required: ["orderId", "requestId", "payload"],
        },
        request: {
          path: "/v1/orders/{orderId}",
          bodyInputPath: "payload",
        },
        behavior: {
          retry: {
            mode: "transient",
            maxAttempts: 2,
            baseDelayMs: 10,
            maxDelayMs: 10,
          },
          idempotency: {
            mode: "keyed",
            keyField: "requestId",
          },
        },
      },
    ],
  });

  const registry = new ToolRegistry();
  new ConnectorRegistryAdapter(registry, {
    sleep: async () => undefined,
  }).register(instance(connector, secretProvider({})));

  const output = await registry.get("generic-rest.primary.orders.update")!.execute(
    {
      orderId: 77,
      requestId: "req-77",
      payload: { status: "processing" },
    },
    { correlationId: "corr-write", actor: "agent-1" },
  );

  assert.deepEqual(output, {
    status: 200,
    body: { accepted: true },
  });
  assert.equal(calls, 2);
  assert.deepEqual(observed, [
    {
      idempotencyKey: "req-77",
      body: JSON.stringify({ status: "processing" }),
    },
    {
      idempotencyKey: "req-77",
      body: JSON.stringify({ status: "processing" }),
    },
  ]);
});

test("API key query authentication is sourced from SecretProvider", async () => {
  let capturedUrl = "";
  const fetchImpl: typeof fetch = async (input) => {
    capturedUrl = String(input);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const connector = createGenericRestConnector({
    fetch: fetchImpl,
    auth: {
      type: "api_key",
      requirementId: "service",
      fieldId: "key",
      location: "query",
      name: "api_key",
    },
    endpoints: [
      {
        id: "ping.get",
        name: "Ping",
        description: "API key query authentication test",
        risk: "READ",
        method: "GET",
        inputSchema: { type: "object" },
        request: { path: "/ping" },
      },
    ],
  });

  const registry = new ToolRegistry();
  new ConnectorRegistryAdapter(registry).register(
    instance(connector, secretProvider({ "service.key": "key-123" })),
  );

  await registry.get("generic-rest.primary.ping.get")!.execute(
    {},
    { correlationId: "corr-api-key", actor: "agent-1" },
  );

  assert.equal(new URL(capturedUrl).searchParams.get("api_key"), "key-123");
});

test("static sensitive headers and unsafe endpoint paths are rejected", () => {
  assert.throws(
    () =>
      createGenericRestConnector({
        defaultHeaders: { Authorization: "Bearer hard-coded-secret" },
        endpoints: [
          {
            id: "ping.get",
            name: "Ping",
            description: "Unsafe static auth header",
            risk: "READ",
            method: "GET",
            inputSchema: { type: "object" },
            request: { path: "/ping" },
          },
        ],
      }),
    /SecretProvider/,
  );

  assert.throws(
    () =>
      createGenericRestConnector({
        endpoints: [
          {
            id: "unsafe.get",
            name: "Unsafe",
            description: "Network path must be rejected",
            risk: "READ",
            method: "GET",
            inputSchema: { type: "object" },
            request: { path: "//evil.example/path" },
          },
        ],
      }),
    /unsafe|start with/i,
  );
});

test("HTTP base URLs are rejected unless explicitly enabled", async () => {
  const connector = createGenericRestConnector({
    fetch: async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    endpoints: [
      {
        id: "ping.get",
        name: "Ping",
        description: "HTTPS policy test",
        risk: "READ",
        method: "GET",
        inputSchema: { type: "object" },
        request: { path: "/ping" },
      },
    ],
  });

  const registry = new ToolRegistry();
  new ConnectorRegistryAdapter(registry).register(
    instance(connector, secretProvider({}), "http://api.example.test"),
  );

  await assert.rejects(
    () =>
      registry.get("generic-rest.primary.ping.get")!.execute(
        {},
        { correlationId: "corr-http", actor: "agent-1" },
      ),
    /must use HTTPS/,
  );
});

test("redirect responses are not followed", async () => {
  let calls = 0;
  const connector = createGenericRestConnector({
    fetch: async (_input, init) => {
      calls += 1;
      assert.equal(init?.redirect, "manual");
      return new Response(null, {
        status: 302,
        headers: { location: "https://evil.example/steal" },
      });
    },
    endpoints: [
      {
        id: "redirect.get",
        name: "Redirect",
        description: "Redirect safety test",
        risk: "READ",
        method: "GET",
        inputSchema: { type: "object" },
        request: { path: "/redirect" },
      },
    ],
  });

  const registry = new ToolRegistry();
  new ConnectorRegistryAdapter(registry).register(
    instance(connector, secretProvider({})),
  );

  await assert.rejects(
    () =>
      registry.get("generic-rest.primary.redirect.get")!.execute(
        {},
        { correlationId: "corr-redirect", actor: "agent-1" },
      ),
    /redirects are disabled/,
  );
  assert.equal(calls, 1);
});

test("response byte limits are enforced before returning tool output", async () => {
  const connector = createGenericRestConnector({
    fetch: async () =>
      new Response("0123456789ABCDEF", {
        status: 200,
        headers: {
          "content-type": "text/plain",
          "content-length": "16",
        },
      }),
    endpoints: [
      {
        id: "small.get",
        name: "Small response",
        description: "Response limit test",
        risk: "READ",
        method: "GET",
        inputSchema: { type: "object" },
        request: { path: "/small" },
        response: { mode: "text", maxBytes: 8 },
      },
    ],
  });

  const registry = new ToolRegistry();
  new ConnectorRegistryAdapter(registry).register(
    instance(connector, secretProvider({})),
  );

  await assert.rejects(
    () =>
      registry.get("generic-rest.primary.small.get")!.execute(
        {},
        { correlationId: "corr-size", actor: "agent-1" },
      ),
    /exceeds 8 bytes/,
  );
});

test("text responses redact resolved authentication secrets", async () => {
  const connector = createGenericRestConnector({
    auth: {
      type: "bearer",
      requirementId: "api",
      tokenField: "token",
    },
    fetch: async () =>
      new Response("token=top-secret-token Authorization: Bearer other-token", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    endpoints: [
      {
        id: "text.get",
        name: "Text",
        description: "Text redaction test",
        risk: "READ",
        method: "GET",
        inputSchema: { type: "object" },
        request: { path: "/text" },
        response: { mode: "text" },
      },
    ],
  });

  const registry = new ToolRegistry();
  new ConnectorRegistryAdapter(registry).register(
    instance(connector, secretProvider({ "api.token": "top-secret-token" })),
  );

  const output = await registry.get("generic-rest.primary.text.get")!.execute(
    {},
    { correlationId: "corr-text", actor: "agent-1" },
  );

  assert.deepEqual(output, {
    status: 200,
    body: "token=[REDACTED] Authorization: Bearer [REDACTED]",
  });
});

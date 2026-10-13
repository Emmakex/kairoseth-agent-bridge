import assert from "node:assert/strict";
import test from "node:test";

import {
  BridgeRuntime,
  ConnectorRegistryAdapter,
  InMemoryAuditOutboxStore,
  SanitizedAuditSink,
  ToolRegistry,
  createGenericRestConnector,
  type ConnectorInstance,
  type GenericRestHttpRuntime,
} from "../../src/index.js";

const runtimeHttp: GenericRestHttpRuntime = {
  async resolveHost() {
    return ["93.184.216.34"];
  },
  async fetch(url, init) {
    if (init.method === "GET") {
      return new Response(
        JSON.stringify({
          id: 7,
          name: "Customer Seven",
          access_token: "remote-secret-must-be-redacted",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }

    throw new Error(`WRITE request must not reach HTTP runtime: ${url}`);
  },
};

const connector = createGenericRestConnector(
  {
    operations: [
      {
        id: "customers.get",
        name: "Get customer",
        description: "Read a customer from an external REST API",
        risk: "READ",
        method: "GET",
        pathTemplate: "/customers/{customerId}",
        inputSchema: {
          type: "object",
          properties: { customerId: { type: "integer" } },
          required: ["customerId"],
        },
      },
      {
        id: "customers.update",
        name: "Update customer",
        description: "Update a customer in an external REST API",
        risk: "WRITE",
        method: "PATCH",
        pathTemplate: "/customers/{customerId}",
        body: { source: "field", field: "changes" },
        inputSchema: {
          type: "object",
          properties: {
            customerId: { type: "integer" },
            changes: { type: "object" },
          },
          required: ["customerId", "changes"],
        },
      },
    ],
  },
  runtimeHttp,
);

const instance: ConnectorInstance = {
  instanceId: "crm-demo",
  connector,
  config: { baseUrl: "https://crm.example.test/api" },
  secrets: {
    async getSecret() {
      return null;
    },
  },
};

test("Generic REST tools inherit Bridge policy and sanitized audit without core-specific connector code", async () => {
  const registry = new ToolRegistry();
  new ConnectorRegistryAdapter(registry).register(instance);

  const outbox = new InMemoryAuditOutboxStore();
  const audit = new SanitizedAuditSink(
    {
      tenantId: "tenant-rest",
      installationId: "installation-rest",
      bridgeInstanceId: "bridge-rest",
    },
    outbox,
  );
  const bridge = new BridgeRuntime({ registry, audit });

  const read = await bridge.invoke(
    "generic-rest.crm-demo.customers.get",
    { customerId: 7 },
    {
      correlationId: "corr-rest-read",
      actor: "agent-rest",
      tenantId: "tenant-rest",
      installationId: "installation-rest",
    },
  );

  assert.equal(read.status, "executed");
  if (read.status === "executed") {
    assert.deepEqual(read.output, {
      status: 200,
      ok: true,
      body: {
        id: 7,
        name: "Customer Seven",
        access_token: "[REDACTED]",
      },
    });
  }

  const write = await bridge.invoke(
    "generic-rest.crm-demo.customers.update",
    { customerId: 7, changes: { name: "Changed" } },
    {
      correlationId: "corr-rest-write",
      actor: "agent-rest",
      tenantId: "tenant-rest",
      installationId: "installation-rest",
    },
  );

  assert.equal(write.status, "approval_required");

  const events = await outbox.peek(100);
  assert.ok(events.some((event) => event.toolId === "generic-rest.crm-demo.customers.get"));
  assert.ok(events.some((event) => event.toolId === "generic-rest.crm-demo.customers.update"));
  assert.doesNotMatch(JSON.stringify(events), /remote-secret-must-be-redacted/);
});

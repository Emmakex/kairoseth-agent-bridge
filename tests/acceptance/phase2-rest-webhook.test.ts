import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import {
  BridgeRuntime,
  ConnectorRegistryAdapter,
  InMemoryAuditOutboxStore,
  InMemoryWebhookEventOutboxStore,
  InMemoryWebhookReplayStore,
  SanitizedAuditSink,
  ToolRegistry,
  WebhookAdapter,
  createGenericRestConnector,
  type ConnectorInstance,
  type GenericRestHttpRuntime,
  type WebhookDefinition,
} from "../../src/index.js";

const NOW = new Date("2026-10-13T15:20:00.000Z");
const TIMESTAMP = String(Math.floor(NOW.getTime() / 1000));
const WEBHOOK_SECRET = "phase2-webhook-secret";

function signWebhook(body: Uint8Array, nonce: string): string {
  const hmac = createHmac("sha256", WEBHOOK_SECRET);
  hmac.update(`${TIMESTAMP}.${nonce}.`, "utf8");
  hmac.update(body);
  return `sha256=${hmac.digest("hex")}`;
}

const httpRuntime: GenericRestHttpRuntime = {
  async resolveHost() {
    return ["93.184.216.34"];
  },
  async fetch(_url, init) {
    if (init.method === "GET") {
      return new Response(
        JSON.stringify({
          id: 7,
          state: "active",
          access_token: "rest-secret-that-must-not-escape",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }

    throw new Error("Mutating REST call must remain behind Bridge approval policy.");
  },
};

const restConnector = createGenericRestConnector(
  {
    operations: [
      {
        id: "customers.get",
        name: "Get customer",
        description: "Read a customer selected by a webhook event",
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
        description: "Mutating follow-up that still requires Bridge approval",
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
  httpRuntime,
);

const restInstance: ConnectorInstance = {
  instanceId: "crm-phase2",
  connector: restConnector,
  config: { baseUrl: "https://crm.example.test/api" },
  secrets: {
    async getSecret() {
      return null;
    },
  },
};

const webhookDefinition: WebhookDefinition = {
  id: "crm.customer.changed",
  name: "CRM customer changed",
  description: "Authenticated customer-change notification",
  path: "/webhooks/crm/customer-changed",
  auth: {
    type: "hmac_sha256",
    requirementId: "crm-webhook",
    secretField: "secret",
  },
  redactKeys: ["vendorSecret"],
};

test("Phase 2: authenticated webhook event can drive normalized REST tools without bypassing Bridge policy/audit", async () => {
  const webhookOutbox = new InMemoryWebhookEventOutboxStore();
  const webhookAdapter = new WebhookAdapter(
    new InMemoryWebhookReplayStore(),
    webhookOutbox,
    { now: () => NOW },
  );

  const nonce = "crm-change-0007";
  const rawBody = Buffer.from(
    JSON.stringify({
      customerId: 7,
      vendorSecret: "must-be-redacted",
      note: `echo ${WEBHOOK_SECRET}`,
    }),
    "utf8",
  );

  const webhookResult = await webhookAdapter.handle(
    webhookDefinition,
    {
      method: "POST",
      path: webhookDefinition.path,
      headers: {
        "content-type": "application/json",
        "x-kairoseth-timestamp": TIMESTAMP,
        "x-kairoseth-nonce": nonce,
        "x-kairoseth-signature": signWebhook(rawBody, nonce),
      },
      body: rawBody,
    },
    {
      secrets: {
        async getSecret(requirementId, fieldId) {
          if (requirementId === "crm-webhook" && fieldId === "secret") {
            return WEBHOOK_SECRET;
          }
          return null;
        },
      },
    },
  );

  assert.equal(webhookResult.accepted, true);
  assert.equal(webhookResult.duplicate, false);

  const webhookEvents = await webhookOutbox.list();
  assert.equal(webhookEvents.length, 1);
  const payload = webhookEvents[0]?.payload as Record<string, unknown>;
  assert.equal(payload.customerId, 7);
  assert.equal(payload.vendorSecret, "[REDACTED]");
  assert.equal(payload.note, "echo [REDACTED]");

  const registry = new ToolRegistry();
  new ConnectorRegistryAdapter(registry).register(restInstance);

  const auditOutbox = new InMemoryAuditOutboxStore();
  const audit = new SanitizedAuditSink(
    {
      tenantId: "tenant-phase2",
      installationId: "installation-phase2",
      bridgeInstanceId: "bridge-phase2",
    },
    auditOutbox,
  );
  const bridge = new BridgeRuntime({ registry, audit });

  const read = await bridge.invoke(
    "generic-rest.crm-phase2.customers.get",
    { customerId: payload.customerId },
    {
      correlationId: `webhook-${webhookResult.eventId}`,
      actor: "phase2-event-router",
      tenantId: "tenant-phase2",
      installationId: "installation-phase2",
    },
  );

  assert.equal(read.status, "executed");
  if (read.status === "executed") {
    assert.deepEqual(read.output, {
      status: 200,
      ok: true,
      body: {
        id: 7,
        state: "active",
        access_token: "[REDACTED]",
      },
    });
  }

  const write = await bridge.invoke(
    "generic-rest.crm-phase2.customers.update",
    { customerId: 7, changes: { state: "blocked" } },
    {
      correlationId: `webhook-write-${webhookResult.eventId}`,
      actor: "phase2-event-router",
      tenantId: "tenant-phase2",
      installationId: "installation-phase2",
    },
  );
  assert.equal(write.status, "approval_required");

  const auditEvents = await auditOutbox.peek(100);
  assert.ok(
    auditEvents.some(
      (event) => event.toolId === "generic-rest.crm-phase2.customers.get",
    ),
  );
  assert.ok(
    auditEvents.some(
      (event) => event.toolId === "generic-rest.crm-phase2.customers.update",
    ),
  );

  const combined = JSON.stringify({ webhookEvents, auditEvents, read, write });
  assert.doesNotMatch(combined, /phase2-webhook-secret/);
  assert.doesNotMatch(combined, /rest-secret-that-must-not-escape/);
  assert.doesNotMatch(combined, /must-be-redacted/);
});

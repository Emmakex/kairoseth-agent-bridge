import assert from "node:assert/strict";
import test from "node:test";

import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type { AuthInfo } from "@modelcontextprotocol/server";

import {
  BridgeRuntime,
  InMemoryAuditOutboxStore,
  McpToolAdapter,
  SanitizedAuditSink,
  ToolRegistry,
  createKairosethMcpHttpHandler,
} from "../../src/index.js";

test("Phase 3 MCP transport preserves authenticated identity, policy and audit end-to-end", async () => {
  const registry = new ToolRegistry();
  let writeExecutions = 0;

  registry.register({
    id: "orders.get",
    name: "Get order",
    description: "Read one order",
    localizations: {
      es: { name: "Obtener pedido", description: "Consultar un pedido" },
      en: { name: "Get order", description: "Read one order" },
    },
    risk: "READ",
    inputSchema: {
      type: "object",
      properties: { orderId: { type: "integer" } },
      required: ["orderId"],
    },
    async execute(input, context) {
      return {
        id: (input as { orderId: number }).orderId,
        actor: context.actor,
        tenantId: context.tenantId,
      };
    },
  });

  registry.register({
    id: "orders.cancel",
    name: "Cancel order",
    description: "Cancel one order",
    localizations: {
      es: { name: "Cancelar pedido", description: "Cancelar un pedido" },
      en: { name: "Cancel order", description: "Cancel one order" },
    },
    risk: "CRITICAL",
    inputSchema: {
      type: "object",
      properties: { orderId: { type: "integer" } },
      required: ["orderId"],
    },
    async execute() {
      writeExecutions += 1;
      return { cancelled: true };
    },
  });

  const outbox = new InMemoryAuditOutboxStore();
  const audit = new SanitizedAuditSink(
    {
      tenantId: "tenant-mcp-e2e",
      installationId: "installation-mcp-e2e",
      bridgeInstanceId: "bridge-mcp-e2e",
    },
    outbox,
  );
  const bridge = new BridgeRuntime({ registry, audit });
  const handler = createKairosethMcpHttpHandler({
    adapter: new McpToolAdapter(bridge),
    resolveInvocation(context) {
      if (!context.authInfo) {
        throw new Error("verified authInfo is required");
      }
      return {
        correlationId: `mcp-e2e-${String(context.mcpRequestId ?? "request")}`,
        actor: context.authInfo.clientId,
        tenantId: "tenant-mcp-e2e",
        installationId: "installation-mcp-e2e",
        metadata: { locale: "en" },
      };
    },
  });

  const authInfo: AuthInfo = {
    token: "verified-token-not-for-audit",
    clientId: "trusted-agent-e2e",
    scopes: ["mcp"],
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
  const transport = new StreamableHTTPClientTransport(
    new URL("http://test.local/mcp"),
    {
      fetch: (url, init) =>
        handler.fetch(new Request(url, init), { authInfo }),
    },
  );
  const client = new Client(
    { name: "kairoseth-phase3-acceptance", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );

  try {
    await client.connect(transport);

    const listed = await client.listTools();
    assert.ok(listed.tools.some((tool) => tool.name === "orders.get"));
    assert.ok(listed.tools.some((tool) => tool.name === "orders.cancel"));

    const read = await client.callTool({
      name: "orders.get",
      arguments: { orderId: 42 },
    });
    assert.equal(read.isError, undefined);
    assert.deepEqual(read.structuredContent, {
      id: 42,
      actor: "trusted-agent-e2e",
      tenantId: "tenant-mcp-e2e",
    });

    const critical = await client.callTool({
      name: "orders.cancel",
      arguments: { orderId: 42 },
    });
    assert.equal(critical.isError, true);
    assert.equal(writeExecutions, 0);
    assert.deepEqual(
      (critical.structuredContent as { code?: string } | undefined)?.code,
      "KAIROSETH_APPROVAL_REQUIRED",
    );

    const events = await outbox.peek(100);
    assert.ok(events.some((event) => event.toolId === "orders.get"));
    assert.ok(events.some((event) => event.toolId === "orders.cancel"));
    assert.ok(events.some((event) => event.actor === "trusted-agent-e2e"));
    assert.doesNotMatch(JSON.stringify(events), /verified-token-not-for-audit/);
  } finally {
    await client.close();
    await handler.close();
  }
});

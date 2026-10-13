import assert from "node:assert/strict";
import test from "node:test";

import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type { AuthInfo } from "@modelcontextprotocol/server";

import {
  BridgeRuntime,
  McpToolAdapter,
  ToolRegistry,
  createKairosethMcpHttpHandler,
} from "../../src/index.js";

test("official MCP v2 client discovers Spanish tools and cannot bypass WRITE approval", async () => {
  const registry = new ToolRegistry();
  let writeExecutions = 0;

  registry.register({
    id: "customers.get",
    name: "Get customer",
    description: "Read one customer",
    localizations: {
      en: {
        name: "Get customer",
        description: "Read one customer",
      },
      es: {
        name: "Obtener cliente",
        description: "Consultar un cliente",
      },
    },
    risk: "READ",
    inputSchema: {
      type: "object",
      properties: { customerId: { type: "integer" } },
      required: ["customerId"],
    },
    async execute(input, context) {
      return {
        id: (input as { customerId: number }).customerId,
        actor: context.actor,
      };
    },
  });

  registry.register({
    id: "customers.update",
    name: "Update customer",
    description: "Update one customer",
    localizations: {
      en: {
        name: "Update customer",
        description: "Update one customer",
      },
      es: {
        name: "Actualizar cliente",
        description: "Actualizar un cliente",
      },
    },
    risk: "WRITE",
    inputSchema: { type: "object", additionalProperties: true },
    async execute() {
      writeExecutions += 1;
      return { updated: true };
    },
  });

  const handler = createKairosethMcpHttpHandler({
    adapter: new McpToolAdapter(new BridgeRuntime({ registry })),
    defaultLocale: "en",
    resolveInvocation(context) {
      if (!context.authInfo) {
        throw new Error("verified MCP authInfo is required");
      }
      return {
        correlationId: `mcp-${String(context.mcpRequestId ?? "request")}`,
        actor: context.authInfo.clientId,
        tenantId: "tenant-mcp",
        installationId: "installation-mcp",
        metadata: { locale: "es" },
      };
    },
  });

  const authInfo: AuthInfo = {
    token: "verified-test-token",
    clientId: "agent-es",
    scopes: ["mcp"],
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };

  const transport = new StreamableHTTPClientTransport(
    new URL("http://test.local/mcp"),
    {
      requestInit: {
        headers: { "Accept-Language": "es-ES,es;q=0.9,en;q=0.8" },
      },
      fetch: (url, init) =>
        handler.fetch(new Request(url, init), { authInfo }),
    },
  );
  const client = new Client(
    { name: "kairoseth-mcp-test", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );

  try {
    await client.connect(transport);
    assert.equal(client.getProtocolEra(), "modern");

    const listed = await client.listTools();
    const readTool = listed.tools.find((tool) => tool.name === "customers.get");
    const writeTool = listed.tools.find((tool) => tool.name === "customers.update");

    assert.equal(readTool?.title, "Obtener cliente");
    assert.equal(readTool?.description, "Consultar un cliente");
    assert.equal(writeTool?.title, "Actualizar cliente");

    const read = await client.callTool({
      name: "customers.get",
      arguments: { customerId: 7 },
    });
    assert.deepEqual(read.structuredContent, { id: 7, actor: "agent-es" });

    const write = await client.callTool({
      name: "customers.update",
      arguments: { customerId: 7 },
    });
    assert.equal(write.isError, true);
    assert.equal(writeExecutions, 0);
    assert.match(
      write.content[0]?.type === "text" ? write.content[0].text : "",
      /requiere aprobación/i,
    );
  } finally {
    await client.close();
    await handler.close();
  }
});

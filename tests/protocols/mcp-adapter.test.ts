import assert from "node:assert/strict";
import test from "node:test";

import {
  BridgeRuntime,
  ConnectorRegistryAdapter,
  McpAdapterError,
  McpToolAdapter,
  ToolRegistry,
  type ConnectorDefinition,
  type ConnectorInstance,
} from "../../src/index.js";

function invocation(correlationId: string) {
  return {
    correlationId,
    actor: "mcp-host",
    tenantId: "tenant-mcp",
    installationId: "installation-mcp",
  };
}

test("MCP tools/list is deterministic, private and maps Bridge risk to hints", () => {
  const registry = new ToolRegistry();
  registry.register({
    id: "zeta.read",
    name: "Zeta read",
    description: "Read-only fixture",
    risk: "READ",
    inputSchema: {
      type: "object",
      properties: { id: { type: "integer" } },
      required: ["id"],
    },
    async execute() {
      return { ok: true };
    },
  });
  registry.register({
    id: "alpha.delete",
    name: "Alpha delete",
    description: "Critical fixture",
    risk: "CRITICAL",
    hints: { idempotent: true, openWorld: false },
    async execute() {
      return { ok: true };
    },
  });

  const adapter = new McpToolAdapter(new BridgeRuntime({ registry }));
  const listed = adapter.listTools();

  assert.equal(listed.ttlMs, 0);
  assert.equal(listed.cacheScope, "private");
  assert.deepEqual(
    listed.tools.map((tool) => tool.name),
    ["alpha.delete", "zeta.read"],
  );

  assert.deepEqual(listed.tools[0]?.annotations, {
    title: "Alpha delete",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  });
  assert.deepEqual(listed.tools[1]?.annotations, {
    title: "Zeta read",
    readOnlyHint: true,
    destructiveHint: false,
  });
  assert.deepEqual(listed.tools[1]?.inputSchema, {
    type: "object",
    properties: { id: { type: "integer" } },
    required: ["id"],
  });
  assert.deepEqual(listed.tools[0]?.inputSchema, {
    type: "object",
    additionalProperties: true,
  });
});

test("Connector SDK schemas and idempotency hints survive into MCP discovery", () => {
  const connector: ConnectorDefinition = {
    manifest: {
      id: "crm",
      name: "CRM",
      version: "1.0.0",
      description: "MCP schema fixture",
      capabilities: ["customers.write"],
      credentials: [],
    },
    tools: [
      {
        id: "customers.update",
        name: "Update customer",
        description: "Update one customer",
        risk: "WRITE",
        inputSchema: {
          type: "object",
          properties: {
            customerId: { type: "integer" },
            requestId: { type: "string" },
          },
          required: ["customerId", "requestId"],
        },
        outputSchema: {
          type: "object",
          properties: { updated: { type: "boolean" } },
          required: ["updated"],
        },
        behavior: {
          idempotency: { mode: "keyed", keyField: "requestId" },
        },
        async execute() {
          return { updated: true };
        },
      },
    ],
  };
  const instance: ConnectorInstance = {
    instanceId: "primary",
    connector,
    secrets: {
      async getSecret() {
        return null;
      },
    },
  };

  const registry = new ToolRegistry();
  new ConnectorRegistryAdapter(registry).register(instance);
  const tool = new McpToolAdapter(new BridgeRuntime({ registry })).getTool(
    "crm.primary.customers.update",
  );

  assert.ok(tool);
  assert.deepEqual(tool.inputSchema, connector.tools[0]?.inputSchema);
  assert.deepEqual(tool.outputSchema, connector.tools[0]?.outputSchema);
  assert.equal(tool.annotations?.readOnlyHint, false);
  assert.equal(tool.annotations?.destructiveHint, true);
  assert.equal(tool.annotations?.idempotentHint, true);
  assert.equal(tool.annotations?.openWorldHint, true);
});

test("MCP READ call executes only through BridgeRuntime and returns structured output", async () => {
  const registry = new ToolRegistry();
  let executions = 0;
  registry.register({
    id: "customers.get",
    name: "Get customer",
    description: "Read customer",
    risk: "READ",
    inputSchema: {
      type: "object",
      properties: { customerId: { type: "integer" } },
      required: ["customerId"],
    },
    outputSchema: {
      type: "object",
      properties: { id: { type: "integer" } },
      required: ["id"],
    },
    async execute(input) {
      executions += 1;
      return { id: (input as { customerId: number }).customerId };
    },
  });

  const result = await new McpToolAdapter(new BridgeRuntime({ registry })).callTool(
    { name: "customers.get", arguments: { customerId: 7 } },
    invocation("corr-mcp-read"),
  );

  assert.equal(executions, 1);
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, { id: 7 });
  assert.deepEqual(result.content, [{ type: "text", text: '{"id":7}' }]);
});

test("MCP WRITE call cannot bypass Kairoseth approval policy", async () => {
  const registry = new ToolRegistry();
  let executions = 0;
  registry.register({
    id: "customers.update",
    name: "Update customer",
    description: "Write customer",
    risk: "WRITE",
    async execute() {
      executions += 1;
      return { updated: true };
    },
  });

  const result = await new McpToolAdapter(new BridgeRuntime({ registry })).callTool(
    { name: "customers.update", arguments: { customerId: 7 } },
    invocation("corr-mcp-write"),
  );

  assert.equal(executions, 0);
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, {
    code: "KAIROSETH_APPROVAL_REQUIRED",
    correlationId: "corr-mcp-write",
  });
  assert.match(result.content[0]?.text ?? "", /Approval required/);
});

test("unknown or invalid MCP tool names fail before execution", async () => {
  const adapter = new McpToolAdapter(new BridgeRuntime());

  await assert.rejects(
    () =>
      adapter.callTool(
        { name: "missing.tool", arguments: {} },
        invocation("corr-missing"),
      ),
    (error: unknown) =>
      error instanceof McpAdapterError && error.code === "UNKNOWN_TOOL",
  );

  assert.throws(
    () => adapter.getTool("invalid tool name"),
    (error: unknown) =>
      error instanceof McpAdapterError && error.code === "INVALID_TOOL_NAME",
  );
});

test("MCP tool names preserve Bridge dotted namespaces and reject >128 chars", () => {
  const registry = new ToolRegistry();
  registry.register({
    id: "generic-rest.crm.customers.get",
    name: "Get customer",
    description: "Namespaced connector tool",
    risk: "READ",
    async execute() {
      return null;
    },
  });

  const adapter = new McpToolAdapter(new BridgeRuntime({ registry }));
  assert.equal(adapter.listTools().tools[0]?.name, "generic-rest.crm.customers.get");

  registry.register({
    id: `tool.${"x".repeat(124)}`,
    name: "Too long",
    description: "MCP should reject this during discovery",
    risk: "READ",
    async execute() {
      return null;
    },
  });

  assert.throws(
    () => adapter.listTools(),
    (error: unknown) =>
      error instanceof McpAdapterError && error.code === "INVALID_TOOL_NAME",
  );
});

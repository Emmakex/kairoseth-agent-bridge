import assert from "node:assert/strict";
import test from "node:test";

import {
  A2AAgentCardAdapter,
  A2AExecutionError,
  A2AToolExecutionAdapter,
  BridgeRuntime,
  KAIROSETH_A2A_TOOL_INVOCATION_EXTENSION_URI,
  MemoryAuditSink,
  ToolRegistry,
  type A2AExecutionContext,
  type A2ASendMessageRequest,
  type InvocationContext,
  type PolicyEvaluator,
  type ToolDefinition,
} from "../../src/index.js";

function ids(): () => string {
  let value = 0;
  return () => `generated-${++value}`;
}

function tool(
  id: string,
  risk: "READ" | "WRITE" | "CRITICAL",
  execute: ToolDefinition["execute"],
): ToolDefinition {
  return {
    id,
    name: `Canonical ${id}`,
    description: `Canonical description ${id}`,
    localizations: {
      es: {
        name: `ES ${id}`,
        description: `Descripción ES ${id}`,
      },
      en: {
        name: `EN ${id}`,
        description: `EN description ${id}`,
      },
    },
    risk,
    inputSchema: { type: "object", additionalProperties: true },
    outputSchema: { type: "object", additionalProperties: true },
    execute,
  };
}

function request(
  toolId: string,
  input: unknown,
  options: { messageId?: string; taskId?: string; contextId?: string } = {},
): A2ASendMessageRequest {
  return {
    message: {
      messageId: options.messageId ?? "message-1",
      ...(options.taskId ? { taskId: options.taskId } : {}),
      ...(options.contextId ? { contextId: options.contextId } : {}),
      role: "ROLE_USER",
      parts: [
        {
          data: {
            version: "kairoseth.tool-invocation.v1",
            toolId,
            input,
          },
          mediaType: "application/json",
        },
      ],
      extensions: [KAIROSETH_A2A_TOOL_INVOCATION_EXTENSION_URI],
    },
  };
}

function context(
  options: {
    actor?: string;
    tenantId?: string;
    installationId?: string;
    correlationId?: string;
    approvalToken?: string;
    locale?: "es" | "en";
    activated?: boolean;
  } = {},
): A2AExecutionContext {
  return {
    protocolVersion: "1.0",
    activatedExtensions:
      options.activated === false
        ? []
        : [KAIROSETH_A2A_TOOL_INVOCATION_EXTENSION_URI],
    locale: options.locale ?? "en",
    invocation: {
      actor: options.actor ?? "agent:trusted",
      tenantId: options.tenantId ?? "tenant-1",
      installationId: options.installationId ?? "installation-1",
      correlationId: options.correlationId ?? "correlation-1",
      ...(options.approvalToken
        ? { approvalToken: options.approvalToken }
        : {}),
    },
  };
}

function assertA2AError(
  error: unknown,
  code: A2AExecutionError["code"],
): boolean {
  assert.ok(error instanceof A2AExecutionError);
  assert.equal(error.code, code);
  return true;
}

test("A2A READ executes through BridgeRuntime and returns a structured Artifact", async () => {
  const registry = new ToolRegistry();
  const audit = new MemoryAuditSink();
  let seenContext: InvocationContext | undefined;
  let seenInput: unknown;
  registry.register(
    tool("demo.orders.get", "READ", async (input, invocation) => {
      seenInput = input;
      seenContext = invocation;
      return { orderId: 42, status: "processing" };
    }),
  );
  const runtime = new BridgeRuntime({ registry, audit });
  const adapter = new A2AToolExecutionAdapter(runtime, {
    idGenerator: ids(),
    now: () => new Date("2026-10-14T06:30:00.000Z"),
  });

  const response = await adapter.sendMessage(
    request("demo.orders.get", { id: 42 }, { contextId: "context-client" }),
    context(),
  );
  assert.ok("task" in response);
  assert.equal(response.task.id, "generated-1");
  assert.equal(response.task.contextId, "context-client");
  assert.equal(response.task.status.state, "TASK_STATE_COMPLETED");
  assert.deepEqual(response.task.artifacts?.[0]?.parts[0]?.data, {
    orderId: 42,
    status: "processing",
  });
  assert.equal(response.task.artifacts?.[0]?.parts[0]?.mediaType, "application/json");
  assert.deepEqual(seenInput, { id: 42 });
  assert.equal(seenContext?.actor, "agent:trusted");
  assert.equal(seenContext?.tenantId, "tenant-1");
  assert.equal(seenContext?.installationId, "installation-1");
  assert.equal(seenContext?.metadata?.protocol, "a2a");
  assert.equal(seenContext?.metadata?.["a2a.taskId"], "generated-1");
  assert.deepEqual(
    audit.all().map((event) => event.type),
    [
      "INVOCATION_RECEIVED",
      "POLICY_EVALUATED",
      "EXECUTION_STARTED",
      "EXECUTION_SUCCEEDED",
    ],
  );
});

test("A2A WRITE becomes AUTH_REQUIRED in Spanish and has zero side effects", async () => {
  const registry = new ToolRegistry();
  let executions = 0;
  registry.register(
    tool("demo.orders.update", "WRITE", async () => {
      executions += 1;
      return { ok: true };
    }),
  );
  const adapter = new A2AToolExecutionAdapter(
    new BridgeRuntime({ registry }),
    { idGenerator: ids() },
  );

  const response = await adapter.sendMessage(
    request("demo.orders.update", { status: "completed" }),
    context({ locale: "es" }),
  );
  assert.ok("task" in response);
  assert.equal(response.task.status.state, "TASK_STATE_AUTH_REQUIRED");
  assert.match(
    response.task.status.message?.parts[0]?.text ?? "",
    /requiere autorización/i,
  );
  assert.equal(executions, 0);

  const fetched = await adapter.getTask(
    { id: response.task.id },
    context({ locale: "es" }),
  );
  assert.equal(fetched.status.state, "TASK_STATE_AUTH_REQUIRED");

  await assert.rejects(
    () =>
      adapter.getTask(
        { id: response.task.id },
        context({ actor: "agent:other", locale: "es" }),
      ),
    (error) => assertA2AError(error, "TASK_NOT_FOUND"),
  );
});

test("A2A approval resume preserves original action and correlation", async () => {
  const registry = new ToolRegistry();
  let executions = 0;
  let executedContext: InvocationContext | undefined;
  registry.register(
    tool("demo.stock.set", "WRITE", async (_input, invocation) => {
      executions += 1;
      executedContext = invocation;
      return { quantity: 7 };
    }),
  );
  const policy: PolicyEvaluator = {
    async evaluate(toolDefinition, _input, invocation) {
      if (toolDefinition.risk === "READ") {
        return { outcome: "ALLOW", reason: "Read allowed." };
      }
      return invocation.approvalToken === "approved"
        ? { outcome: "ALLOW", reason: "Approved." }
        : { outcome: "REQUIRE_APPROVAL", reason: "Approval required." };
    },
  };
  const adapter = new A2AToolExecutionAdapter(
    new BridgeRuntime({ registry, policy }),
    { idGenerator: ids() },
  );

  const first = await adapter.sendMessage(
    request("demo.stock.set", { quantity: 7 }, { messageId: "message-first" }),
    context({ correlationId: "correlation-original" }),
  );
  assert.ok("task" in first);
  assert.equal(first.task.status.state, "TASK_STATE_AUTH_REQUIRED");
  assert.equal(executions, 0);

  await assert.rejects(
    () =>
      adapter.sendMessage(
        request(
          "demo.stock.set",
          { quantity: 8 },
          {
            messageId: "message-tampered",
            taskId: first.task.id,
            contextId: first.task.contextId,
          },
        ),
        context({ approvalToken: "approved", correlationId: "correlation-new" }),
      ),
    (error) => assertA2AError(error, "INVALID_REQUEST"),
  );
  assert.equal(executions, 0);

  const resumed = await adapter.sendMessage(
    request(
      "demo.stock.set",
      { quantity: 7 },
      {
        messageId: "message-resume",
        taskId: first.task.id,
        contextId: first.task.contextId,
      },
    ),
    context({ approvalToken: "approved", correlationId: "correlation-new" }),
  );
  assert.ok("task" in resumed);
  assert.equal(resumed.task.id, first.task.id);
  assert.equal(resumed.task.status.state, "TASK_STATE_COMPLETED");
  assert.equal(executions, 1);
  assert.equal(executedContext?.correlationId, "correlation-original");
  assert.equal(executedContext?.approvalToken, "approved");
});

test("A2A message metadata cannot spoof trusted actor, tenant or approval", async () => {
  const registry = new ToolRegistry();
  let seen: InvocationContext | undefined;
  registry.register(
    tool("demo.identity.read", "READ", async (_input, invocation) => {
      seen = invocation;
      return { ok: true };
    }),
  );
  const adapter = new A2AToolExecutionAdapter(new BridgeRuntime({ registry }));
  const spoofed = request("demo.identity.read", {});
  spoofed.message.metadata = {
    actor: "agent:evil",
    tenantId: "tenant-evil",
    installationId: "installation-evil",
    approvalToken: "forged",
  };

  await adapter.sendMessage(spoofed, context());
  assert.equal(seen?.actor, "agent:trusted");
  assert.equal(seen?.tenantId, "tenant-1");
  assert.equal(seen?.installationId, "installation-1");
  assert.equal(seen?.approvalToken, undefined);
});

test("A2A structured invocation requires negotiated extension and JSON data", async () => {
  const registry = new ToolRegistry();
  registry.register(tool("demo.read", "READ", async () => ({ ok: true })));
  const adapter = new A2AToolExecutionAdapter(new BridgeRuntime({ registry }));

  await assert.rejects(
    () => adapter.sendMessage(request("demo.read", {}), context({ activated: false })),
    (error) => assertA2AError(error, "EXTENSION_REQUIRED"),
  );

  const missingMessageExtension = request("demo.read", {});
  missingMessageExtension.message.extensions = [];
  await assert.rejects(
    () => adapter.sendMessage(missingMessageExtension, context()),
    (error) => assertA2AError(error, "EXTENSION_REQUIRED"),
  );

  const textRequest = request("demo.read", {});
  textRequest.message.parts = [{ text: "run demo.read" }];
  await assert.rejects(
    () => adapter.sendMessage(textRequest, context()),
    (error) => assertA2AError(error, "CONTENT_TYPE_NOT_SUPPORTED"),
  );
});

test("A2A terminal task cannot be re-executed through task continuation", async () => {
  const registry = new ToolRegistry();
  let executions = 0;
  registry.register(
    tool("demo.once", "READ", async () => {
      executions += 1;
      return { ok: true };
    }),
  );
  const adapter = new A2AToolExecutionAdapter(
    new BridgeRuntime({ registry }),
    { idGenerator: ids() },
  );
  const first = await adapter.sendMessage(request("demo.once", {}), context());
  assert.ok("task" in first);
  assert.equal(executions, 1);

  await assert.rejects(
    () =>
      adapter.sendMessage(
        request("demo.once", {}, { taskId: first.task.id, contextId: first.task.contextId }),
        context(),
      ),
    (error) => assertA2AError(error, "UNSUPPORTED_OPERATION"),
  );
  assert.equal(executions, 1);
});

test("A2A Agent Card advertises the execution extension in ES and EN", () => {
  const registry = new ToolRegistry();
  registry.register(tool("demo.read", "READ", async () => ({ ok: true })));
  const extension = {
    es: [
      {
        uri: KAIROSETH_A2A_TOOL_INVOCATION_EXTENSION_URI,
        description: "Invocación estructurada y segura de herramientas Kairoseth.",
        required: true,
        params: { envelope: "kairoseth.tool-invocation.v1" },
      },
    ],
    en: [
      {
        uri: KAIROSETH_A2A_TOOL_INVOCATION_EXTENSION_URI,
        description: "Structured and secure invocation of Kairoseth tools.",
        required: true,
        params: { envelope: "kairoseth.tool-invocation.v1" },
      },
    ],
  } as const;
  const adapter = new A2AAgentCardAdapter(registry, {
    version: "0.1.0-dev.0",
    localizations: {
      es: { name: "Kairoseth", description: "Agente Kairoseth." },
      en: { name: "Kairoseth", description: "Kairoseth agent." },
    },
    supportedInterfaces: [
      {
        url: "https://bridge.example.com/a2a/v1",
        protocolBinding: "HTTP+JSON",
        protocolVersion: "1.0",
      },
    ],
    extensions: extension,
  });

  const es = adapter.getAgentCard("es").capabilities.extensions?.[0];
  const en = adapter.getAgentCard("en").capabilities.extensions?.[0];
  assert.equal(es?.uri, KAIROSETH_A2A_TOOL_INVOCATION_EXTENSION_URI);
  assert.equal(en?.uri, KAIROSETH_A2A_TOOL_INVOCATION_EXTENSION_URI);
  assert.equal(es?.required, true);
  assert.match(es?.description ?? "", /estructurada/i);
  assert.match(en?.description ?? "", /structured/i);

  assert.throws(
    () =>
      new A2AAgentCardAdapter(registry, {
        version: "0.1.0-dev.0",
        localizations: {
          es: { name: "Kairoseth", description: "Agente Kairoseth." },
          en: { name: "Kairoseth", description: "Kairoseth agent." },
        },
        supportedInterfaces: [
          {
            url: "https://bridge.example.com/a2a/v1",
            protocolBinding: "HTTP+JSON",
            protocolVersion: "1.0",
          },
        ],
        extensions: {
          es: extension.es,
          en: [
            {
              ...extension.en[0],
              required: false,
            },
          ],
        },
      }),
    /semantics must match/i,
  );
});

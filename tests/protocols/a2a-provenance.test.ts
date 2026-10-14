import assert from "node:assert/strict";
import test from "node:test";

import {
  A2AIdentityMapper,
  A2AToolExecutionAdapter,
  BridgeRuntime,
  InMemoryAuditOutboxStore,
  KAIROSETH_A2A_TOOL_INVOCATION_EXTENSION_URI,
  MemoryAuditSink,
  SanitizedAuditSink,
  SecureDefaultPolicyEvaluator,
  ToolRegistry,
  createInvocationProvenance,
  deriveChildInvocationProvenance,
  type A2AExecutionContext,
  type InvocationContext,
  type PolicyEvaluator,
  type ToolDefinition,
} from "../../src/index.js";

function readTool(
  id: string,
  execute: ToolDefinition["execute"] = async () => ({ ok: true }),
): ToolDefinition {
  return {
    id,
    name: id,
    description: id,
    localizations: {
      es: { name: `ES ${id}`, description: `Descripción ES ${id}` },
      en: { name: `EN ${id}`, description: `EN description ${id}` },
    },
    risk: "READ",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    execute,
  };
}

function writeTool(
  id: string,
  execute: ToolDefinition["execute"],
): ToolDefinition {
  return {
    ...readTool(id, execute),
    risk: "WRITE",
  };
}

function request(
  toolId: string,
  input: unknown,
  options: { taskId?: string; contextId?: string; messageId?: string } = {},
) {
  return {
    message: {
      messageId: options.messageId ?? "message-1",
      ...(options.taskId ? { taskId: options.taskId } : {}),
      ...(options.contextId ? { contextId: options.contextId } : {}),
      role: "ROLE_USER" as const,
      parts: [
        {
          data: {
            version: "kairoseth.tool-invocation.v1" as const,
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

function mapper(): A2AIdentityMapper {
  return new A2AIdentityMapper(async () => ({
    actor: "agent:child",
    tenantId: "tenant-1",
    installationId: "installation-1",
    delegationRequired: false,
  }));
}

async function mapContext(options: {
  correlationId: string;
  rootCorrelationId?: string;
  parentCorrelationId?: string;
  approvalToken?: string;
}): Promise<A2AExecutionContext> {
  const mapped = await mapper().map({
    principal: {
      issuer: "https://agent.example.com",
      subject: "agent-child",
      authenticationMethod: "oauth2",
      clientId: "client-123",
      scopes: ["orders.read", "profile"],
    },
    correlationId: options.correlationId,
    ...(options.rootCorrelationId
      ? { rootCorrelationId: options.rootCorrelationId }
      : {}),
    ...(options.parentCorrelationId
      ? { parentCorrelationId: options.parentCorrelationId }
      : {}),
    ...(options.approvalToken
      ? { approvalToken: options.approvalToken }
      : {}),
    activatedExtensions: [KAIROSETH_A2A_TOOL_INVOCATION_EXTENSION_URI],
    locale: "en",
  });
  assert.equal(mapped.mapped, true);
  if (!mapped.mapped) throw new Error(mapped.reason);
  return mapped.context;
}

test("protocol-neutral provenance preserves root and links the immediate parent", () => {
  const root = createInvocationProvenance({
    protocol: "a2a",
    correlationId: "root-1",
    principal: {
      issuer: "https://root.example.com",
      subject: "root-agent",
      authenticationMethod: "oauth2",
    },
  });
  assert.equal(root.rootCorrelationId, "root-1");
  assert.equal(root.parentCorrelationId, undefined);

  const parent: InvocationContext = {
    correlationId: "parent-1",
    actor: "agent:parent",
    provenance: {
      ...root,
      parentCorrelationId: "root-1",
    },
  };
  const child = deriveChildInvocationProvenance(
    parent,
    "child-1",
    "a2a",
    {
      issuer: "https://child.example.com",
      subject: "child-agent",
      authenticationMethod: "oauth2",
      clientId: "child-client",
    },
  );

  assert.equal(child.rootCorrelationId, "root-1");
  assert.equal(child.parentCorrelationId, "parent-1");
  assert.equal(child.principal?.subject, "child-agent");

  assert.throws(
    () =>
      createInvocationProvenance({
        protocol: "a2a",
        correlationId: "same",
        parentCorrelationId: "same",
      }),
    /parent correlation cannot equal/i,
  );
});

test("A2A verified identity reaches durable audit with safe cross-agent lineage", async () => {
  const registry = new ToolRegistry();
  registry.register(readTool("demo.provenance.read"));

  const outbox = new InMemoryAuditOutboxStore();
  const audit = new SanitizedAuditSink(
    {
      tenantId: "tenant-1",
      installationId: "installation-1",
      bridgeInstanceId: "bridge-1",
    },
    outbox,
  );
  const runtime = new BridgeRuntime({ registry, audit });
  const adapter = new A2AToolExecutionAdapter(runtime);
  const context = await mapContext({
    correlationId: "child-correlation",
    rootCorrelationId: "root-correlation",
    parentCorrelationId: "parent-correlation",
    approvalToken: "approval-token-must-not-be-audited",
  });

  const response = await adapter.sendMessage(
    request("demo.provenance.read", {}),
    context,
  );
  assert.ok("task" in response && response.task);
  assert.equal(response.task.status.state, "TASK_STATE_COMPLETED");

  const events = await outbox.peek(20);
  assert.equal(events.length, 4);
  for (const event of events) {
    assert.equal(event.correlationId, "child-correlation");
    assert.equal(event.provenance?.protocol, "a2a");
    assert.equal(event.provenance?.rootCorrelationId, "root-correlation");
    assert.equal(event.provenance?.parentCorrelationId, "parent-correlation");
    assert.deepEqual(event.provenance?.principal, {
      issuer: "https://agent.example.com",
      subject: "agent-child",
      authenticationMethod: "oauth2",
      clientId: "client-123",
    });
  }

  const serialized = JSON.stringify(events);
  assert.doesNotMatch(serialized, /orders\.read/);
  assert.doesNotMatch(serialized, /profile/);
  assert.doesNotMatch(serialized, /approval-token-must-not-be-audited/);
});

test("A2A approval resume preserves the original provenance instead of accepting new lineage", async () => {
  const registry = new ToolRegistry();
  let executedContext: InvocationContext | undefined;
  registry.register(
    writeTool("demo.provenance.write", async (_input, context) => {
      executedContext = context;
      return { ok: true };
    }),
  );

  const policy: PolicyEvaluator = {
    async evaluate(tool, _input, context) {
      if (tool.risk === "READ") {
        return new SecureDefaultPolicyEvaluator().evaluate(tool, _input, context);
      }
      return context.approvalToken === "approved"
        ? { outcome: "ALLOW", reason: "Approved." }
        : { outcome: "REQUIRE_APPROVAL", reason: "Approval required." };
    },
  };
  const audit = new MemoryAuditSink();
  const adapter = new A2AToolExecutionAdapter(
    new BridgeRuntime({ registry, policy, audit }),
  );

  const originalContext = await mapContext({
    correlationId: "write-correlation",
    rootCorrelationId: "root-original",
    parentCorrelationId: "parent-original",
  });
  const first = await adapter.sendMessage(
    request("demo.provenance.write", { value: 1 }),
    originalContext,
  );
  assert.ok("task" in first && first.task);
  const firstTask = first.task;
  assert.equal(firstTask.status.state, "TASK_STATE_AUTH_REQUIRED");

  const changedResumeContext = await mapContext({
    correlationId: "different-correlation",
    rootCorrelationId: "root-forged-later",
    parentCorrelationId: "parent-forged-later",
    approvalToken: "approved",
  });
  const resumed = await adapter.sendMessage(
    request(
      "demo.provenance.write",
      { value: 1 },
      {
        taskId: firstTask.id,
        ...(firstTask.contextId ? { contextId: firstTask.contextId } : {}),
        messageId: "message-resume",
      },
    ),
    changedResumeContext,
  );
  assert.ok("task" in resumed && resumed.task);
  assert.equal(resumed.task.status.state, "TASK_STATE_COMPLETED");
  assert.equal(executedContext?.correlationId, "write-correlation");
  assert.equal(executedContext?.provenance?.rootCorrelationId, "root-original");
  assert.equal(executedContext?.provenance?.parentCorrelationId, "parent-original");

  const executionStarted = audit
    .all()
    .find((event) => event.type === "EXECUTION_STARTED");
  assert.equal(executionStarted?.provenance?.rootCorrelationId, "root-original");
  assert.equal(executionStarted?.provenance?.parentCorrelationId, "parent-original");
});

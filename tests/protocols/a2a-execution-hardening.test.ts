import assert from "node:assert/strict";
import test from "node:test";

import {
  A2AExecutionError,
  A2AToolExecutionAdapter,
  BridgeRuntime,
  KAIROSETH_A2A_TOOL_INVOCATION_EXTENSION_URI,
  ToolRegistry,
  type A2AExecutionContext,
  type A2ASendMessageRequest,
  type A2ASendMessageResponse,
  type A2ATask,
  type ToolDefinition,
} from "../../src/index.js";

function readTool(
  id: string,
  execute: ToolDefinition["execute"],
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
    execute,
  };
}

function request(toolId: string, input: unknown = {}): A2ASendMessageRequest {
  return {
    message: {
      messageId: "message-hardening",
      role: "ROLE_USER",
      extensions: [KAIROSETH_A2A_TOOL_INVOCATION_EXTENSION_URI],
      parts: [
        {
          mediaType: "application/json",
          data: {
            version: "kairoseth.tool-invocation.v1",
            toolId,
            input,
          },
        },
      ],
    },
  };
}

function context(): A2AExecutionContext {
  return {
    protocolVersion: "1.0",
    activatedExtensions: [KAIROSETH_A2A_TOOL_INVOCATION_EXTENSION_URI],
    locale: "en",
    invocation: {
      actor: "agent:trusted",
      tenantId: "tenant-1",
      installationId: "installation-1",
      correlationId: "correlation-hardening",
    },
  };
}

function taskFrom(response: A2ASendMessageResponse): A2ATask {
  if (!response.task) throw new Error("Expected Task response.");
  return response.task;
}

test("A2A rejects a protocol tenant that differs from authenticated tenant scope", async () => {
  const registry = new ToolRegistry();
  registry.register(readTool("demo.read", async () => ({ ok: true })));
  const adapter = new A2AToolExecutionAdapter(new BridgeRuntime({ registry }));
  const mismatched = request("demo.read");
  mismatched.tenant = "tenant-other";

  await assert.rejects(
    () => adapter.sendMessage(mismatched, context()),
    (error: unknown) => {
      assert.ok(error instanceof A2AExecutionError);
      assert.equal(error.code, "INVALID_REQUEST");
      return true;
    },
  );
});

test("A2A returns FAILED instead of a transport error when executed output is not JSON-compatible", async () => {
  const registry = new ToolRegistry();
  let executions = 0;
  registry.register(
    readTool("demo.bad-output", async () => {
      executions += 1;
      return { value: 1n };
    }),
  );
  const adapter = new A2AToolExecutionAdapter(new BridgeRuntime({ registry }), {
    idGenerator: (() => {
      let value = 0;
      return () => `hardening-${++value}`;
    })(),
  });

  const response = await adapter.sendMessage(request("demo.bad-output"), context());
  const task = taskFrom(response);

  assert.equal(executions, 1);
  assert.equal(task.status.state, "TASK_STATE_FAILED");
  assert.equal(
    task.status.message?.metadata?.["kairoseth.code"],
    "KAIROSETH_OUTPUT_UNAVAILABLE",
  );
  assert.equal(task.artifacts, undefined);
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  BridgeRuntime,
  MemoryAuditSink,
  ToolRegistry,
  type ToolDefinition,
} from "../../src/index.js";

const context = {
  correlationId: "corr-test-001",
  actor: "test-agent",
};

test("READ tool executes and emits an auditable lifecycle", async () => {
  const registry = new ToolRegistry();
  const audit = new MemoryAuditSink();

  const tool: ToolDefinition = {
    id: "demo.read",
    name: "Demo read",
    description: "Read-only demo tool",
    risk: "READ",
    async execute(input) {
      return { echoed: input };
    },
  };

  registry.register(tool);

  const runtime = new BridgeRuntime({ registry, audit });
  const result = await runtime.invoke("demo.read", { ok: true }, context);

  assert.equal(result.status, "executed");
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

test("WRITE tool requires approval and is not executed", async () => {
  const registry = new ToolRegistry();
  let executed = false;

  registry.register({
    id: "demo.write",
    name: "Demo write",
    description: "Write demo tool",
    risk: "WRITE",
    async execute() {
      executed = true;
      return { ok: true };
    },
  });

  const runtime = new BridgeRuntime({ registry });
  const result = await runtime.invoke("demo.write", {}, context);

  assert.equal(result.status, "approval_required");
  assert.equal(executed, false);
});

test("duplicate tool IDs are rejected", () => {
  const registry = new ToolRegistry();
  const tool: ToolDefinition = {
    id: "demo.same",
    name: "Same",
    description: "Duplicate guard",
    risk: "READ",
    async execute() {
      return null;
    },
  };

  registry.register(tool);
  assert.throws(() => registry.register(tool), /already registered/);
});

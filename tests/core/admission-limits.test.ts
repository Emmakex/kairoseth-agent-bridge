import assert from "node:assert/strict";
import test from "node:test";

import {
  AdmissionControlPolicyEvaluator,
  BridgeRuntime,
  InMemoryFixedWindowRateLimitStore,
  SecureDefaultPolicyEvaluator,
  ToolRegistry,
  type InvocationContext,
  type PolicyEvaluator,
  type RateLimitStore,
  type ToolDefinition,
} from "../../src/index.js";

const BASE_TIME = Date.parse("2026-10-14T09:30:00.000Z");

function tool(
  id: string,
  risk: "READ" | "WRITE" = "READ",
  execute: ToolDefinition["execute"] = async () => ({ ok: true }),
): ToolDefinition {
  return {
    id,
    name: id,
    description: id,
    risk,
    execute,
  };
}

function context(overrides: Partial<InvocationContext> = {}): InvocationContext {
  return {
    correlationId: "corr-1",
    actor: "agent-1",
    tenantId: "tenant-1",
    installationId: "installation-1",
    ...overrides,
  };
}

test("payload limit denies oversized input before base policy", async () => {
  let baseCalls = 0;
  const base: PolicyEvaluator = {
    async evaluate() {
      baseCalls += 1;
      return { outcome: "ALLOW", reason: "base allow" };
    },
  };
  const policy = new AdmissionControlPolicyEvaluator(base, null, {
    maxPayloadBytes: 32,
  });

  const decision = await policy.evaluate(
    tool("demo.read"),
    { value: "x".repeat(100) },
    context(),
  );

  assert.equal(decision.outcome, "DENY");
  assert.match(decision.reason, /payload exceeds/i);
  assert.equal(baseCalls, 0);
});

test("tool-specific payload override permits explicitly bounded larger input", async () => {
  const policy = new AdmissionControlPolicyEvaluator(
    { async evaluate() { return { outcome: "ALLOW", reason: "base allow" }; } },
    null,
    {
      maxPayloadBytes: 32,
      toolPayloadLimits: { "files.write": 256 },
    },
  );

  const decision = await policy.evaluate(
    tool("files.write", "WRITE"),
    { value: "x".repeat(100) },
    context(),
  );
  assert.equal(decision.outcome, "ALLOW");
});

test("fixed-window actor-tool rate limit blocks the next attempt and resets", async () => {
  let nowMs = BASE_TIME;
  let baseCalls = 0;
  const store = new InMemoryFixedWindowRateLimitStore();
  const policy = new AdmissionControlPolicyEvaluator(
    {
      async evaluate() {
        baseCalls += 1;
        return { outcome: "ALLOW", reason: "base allow" };
      },
    },
    store,
    {
      now: () => new Date(nowMs),
      rateLimits: [
        { id: "actor-tool-minute", limit: 2, windowMs: 60_000, scope: "actor-tool" },
      ],
    },
  );
  const target = tool("orders.list");

  assert.equal((await policy.evaluate(target, {}, context())).outcome, "ALLOW");
  assert.equal((await policy.evaluate(target, {}, context())).outcome, "ALLOW");
  const third = await policy.evaluate(target, {}, context());
  assert.equal(third.outcome, "DENY");
  assert.match(third.reason, /rate limit actor-tool-minute exceeded/i);
  assert.equal(baseCalls, 2);

  nowMs += 60_001;
  assert.equal((await policy.evaluate(target, {}, context())).outcome, "ALLOW");
  assert.equal(baseCalls, 3);
});

test("rate scopes isolate actors and tools", async () => {
  const policy = new AdmissionControlPolicyEvaluator(
    { async evaluate() { return { outcome: "ALLOW", reason: "ok" }; } },
    new InMemoryFixedWindowRateLimitStore(),
    {
      now: () => new Date(BASE_TIME),
      rateLimits: [
        { id: "per-actor-tool", limit: 1, windowMs: 60_000, scope: "actor-tool" },
      ],
    },
  );

  assert.equal((await policy.evaluate(tool("orders.list"), {}, context())).outcome, "ALLOW");
  assert.equal(
    (await policy.evaluate(tool("products.list"), {}, context())).outcome,
    "ALLOW",
  );
  assert.equal(
    (
      await policy.evaluate(
        tool("orders.list"),
        {},
        context({ actor: "agent-2" }),
      )
    ).outcome,
    "ALLOW",
  );
  assert.equal((await policy.evaluate(tool("orders.list"), {}, context())).outcome, "DENY");
});

test("concurrent rate-limit attempts have exactly one winner at limit one", async () => {
  const policy = new AdmissionControlPolicyEvaluator(
    { async evaluate() { return { outcome: "ALLOW", reason: "ok" }; } },
    new InMemoryFixedWindowRateLimitStore(),
    {
      now: () => new Date(BASE_TIME),
      rateLimits: [
        { id: "single", limit: 1, windowMs: 60_000, scope: "installation-tool" },
      ],
    },
  );
  const target = tool("critical.read");

  const results = await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      policy.evaluate(
        target,
        { index },
        context({ correlationId: `corr-${index}` }),
      ),
    ),
  );
  assert.equal(results.filter((item) => item.outcome === "ALLOW").length, 1);
  assert.equal(results.filter((item) => item.outcome === "DENY").length, 19);
});

test("missing trusted scope fails closed for a configured scoped rule", async () => {
  const policy = new AdmissionControlPolicyEvaluator(
    { async evaluate() { return { outcome: "ALLOW", reason: "ok" }; } },
    new InMemoryFixedWindowRateLimitStore(),
    {
      rateLimits: [
        { id: "tenant", limit: 10, windowMs: 60_000, scope: "tenant" },
      ],
    },
  );
  const decision = await policy.evaluate(
    tool("demo.read"),
    {},
    {
      correlationId: "corr-no-tenant",
      actor: "agent-1",
      installationId: "installation-1",
    },
  );
  assert.equal(decision.outcome, "DENY");
  assert.match(decision.reason, /trusted scope.*unavailable/i);
});

test("rate-limit store failure is fail-closed by default", async () => {
  const brokenStore: RateLimitStore = {
    async consume() {
      throw new Error("backend down");
    },
    async prune() {
      return 0;
    },
  };
  let baseCalls = 0;
  const policy = new AdmissionControlPolicyEvaluator(
    {
      async evaluate() {
        baseCalls += 1;
        return { outcome: "ALLOW", reason: "ok" };
      },
    },
    brokenStore,
    {
      rateLimits: [
        { id: "installation", limit: 10, windowMs: 60_000, scope: "installation" },
      ],
    },
  );

  const decision = await policy.evaluate(tool("demo.read"), {}, context());
  assert.equal(decision.outcome, "DENY");
  assert.match(decision.reason, /rate limiting is unavailable/i);
  assert.equal(baseCalls, 0);
});

test("admission never replaces secure-default approval for a WRITE", async () => {
  let executions = 0;
  const registry = new ToolRegistry();
  registry.register(
    tool("orders.update", "WRITE", async () => {
      executions += 1;
      return { ok: true };
    }),
  );
  const admissionPolicy = new AdmissionControlPolicyEvaluator(
    new SecureDefaultPolicyEvaluator(),
    new InMemoryFixedWindowRateLimitStore(),
    {
      rateLimits: [
        {
          id: "writes-per-installation",
          limit: 10,
          windowMs: 60_000,
          scope: "installation",
          risks: ["WRITE", "CRITICAL"],
        },
      ],
    },
  );
  const runtime = new BridgeRuntime({ registry, policy: admissionPolicy });

  const result = await runtime.invoke(
    "orders.update",
    { id: 42, state: "processing" },
    context(),
  );
  assert.equal(result.status, "approval_required");
  assert.equal(executions, 0);
});

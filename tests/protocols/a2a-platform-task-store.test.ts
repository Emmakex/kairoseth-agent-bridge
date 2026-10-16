import assert from "node:assert/strict";
import test from "node:test";

import {
  PlatformA2ATaskStore,
  PlatformA2ATaskStoreError,
} from "../../src/protocols/a2a/platform-task-store.js";
import type {
  A2AStoredTask,
  A2ATaskScope,
  A2ATaskTransitionClaim,
} from "../../src/protocols/a2a/task-store.js";

const SCOPE: A2ATaskScope = {
  actor: "agent:finance",
  tenantId: "tenant-1",
  installationId: "installation-1",
};

function record(
  taskId: string,
  state: A2AStoredTask["task"]["status"]["state"] =
    "TASK_STATE_AUTH_REQUIRED",
): A2AStoredTask {
  return {
    task: {
      id: taskId,
      contextId: `context-${taskId}`,
      status: {
        state,
        timestamp: "2026-10-16T09:00:00.000Z",
      },
    },
    scope: { ...SCOPE },
    invocation: {
      toolId: "orders.update",
      input: { orderId: "100", status: "processing" },
      correlationId: `correlation-${taskId}`,
      actionFingerprint: "a".repeat(64),
      provenance: {
        version: "kab.provenance.v1",
        rootCorrelationId: `root-${taskId}`,
        parentCorrelationId: `parent-${taskId}`,
        protocol: "a2a",
      },
    },
  };
}

interface SharedEntry {
  record: A2AStoredTask;
  claimId?: string | undefined;
}

function createAuthoritativePlatform(): {
  fetch: typeof globalThis.fetch;
  entries: Map<string, SharedEntry>;
  authorizationHeaders: string[];
} {
  const entries = new Map<string, SharedEntry>();
  const authorizationHeaders: string[] = [];

  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = input instanceof URL ? input : new URL(String(input));
    const headers = new Headers(init?.headers);
    authorizationHeaders.push(headers.get("authorization") ?? "");
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;

    if (url.pathname.endsWith("/save")) {
      const stored = structuredClone(body.record as A2AStoredTask);
      const existing = entries.get(stored.task.id);
      if (existing?.claimId) {
        return json({ code: "active_claim" }, 409);
      }
      entries.set(stored.task.id, { record: stored });
      return json({ saved: true });
    }

    if (url.pathname.endsWith("/get")) {
      const taskId = body.taskId as string;
      const scope = body.scope as A2ATaskScope;
      const entry = entries.get(taskId);
      return json({
        record:
          entry && sameScope(entry.record.scope, scope)
            ? structuredClone(entry.record)
            : null,
      });
    }

    if (url.pathname.endsWith("/claim")) {
      const taskId = body.taskId as string;
      const scope = body.scope as A2ATaskScope;
      const expectedState = body.expectedState as string;
      const fingerprint = body.expectedActionFingerprint as string;
      const claimId = body.claimId as string;
      const entry = entries.get(taskId);
      if (
        !entry ||
        entry.claimId ||
        !sameScope(entry.record.scope, scope) ||
        entry.record.task.status.state !== expectedState ||
        entry.record.invocation.actionFingerprint !== fingerprint
      ) {
        return json({ claim: null });
      }

      const original = structuredClone(entry.record);
      entry.claimId = claimId;
      entry.record = structuredClone(entry.record);
      entry.record.task.status = {
        ...entry.record.task.status,
        state: "TASK_STATE_WORKING",
      };
      return json({ claim: { claimId, record: original } });
    }

    if (url.pathname.endsWith("/complete")) {
      const claim = body.claim as A2ATaskTransitionClaim;
      const stored = body.record as A2AStoredTask;
      const entry = entries.get(stored.task.id);
      if (
        !entry ||
        entry.claimId !== claim.claimId ||
        !sameScope(entry.record.scope, stored.scope)
      ) {
        return json({ completed: false });
      }
      entries.set(stored.task.id, { record: structuredClone(stored) });
      return json({ completed: true });
    }

    return json({ code: "not_found" }, 404);
  };

  return { fetch: fetchImpl, entries, authorizationHeaders };
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sameScope(left: A2ATaskScope, right: A2ATaskScope): boolean {
  return (
    left.actor === right.actor &&
    left.tenantId === right.tenantId &&
    left.installationId === right.installationId
  );
}

function store(
  fetchImpl: typeof globalThis.fetch,
  accessToken: () => string | Promise<string> = () => "session-token",
): PlatformA2ATaskStore {
  return new PlatformA2ATaskStore({
    baseUrl: "https://kairoseth.example",
    fetch: fetchImpl,
    accessToken,
  });
}

test("PlatformA2ATaskStore provides one atomic claim winner across runtimes", async () => {
  const platform = createAuthoritativePlatform();
  const first = store(platform.fetch);
  const second = store(platform.fetch);
  await first.save(record("task-1"));

  const [left, right] = await Promise.all([
    first.claimTransition(
      "task-1",
      SCOPE,
      "TASK_STATE_AUTH_REQUIRED",
      "a".repeat(64),
      "claim-left",
    ),
    second.claimTransition(
      "task-1",
      SCOPE,
      "TASK_STATE_AUTH_REQUIRED",
      "a".repeat(64),
      "claim-right",
    ),
  ]);

  const winners = [left, right].filter(
    (claim): claim is A2ATaskTransitionClaim => claim !== null,
  );
  assert.equal(winners.length, 1);
  assert.equal(
    platform.entries.get("task-1")?.record.task.status.state,
    "TASK_STATE_WORKING",
  );

  const completed = record("task-1", "TASK_STATE_COMPLETED");
  assert.equal(await first.completeTransition(winners[0]!, completed), true);
  assert.equal(
    (await second.get("task-1", SCOPE))?.task.status.state,
    "TASK_STATE_COMPLETED",
  );
});

test("PlatformA2ATaskStore binds claims to exact fingerprint and scope", async () => {
  const platform = createAuthoritativePlatform();
  const shared = store(platform.fetch);
  await shared.save(record("task-2"));

  assert.equal(
    await shared.claimTransition(
      "task-2",
      SCOPE,
      "TASK_STATE_AUTH_REQUIRED",
      "b".repeat(64),
      "claim-wrong-fingerprint",
    ),
    null,
  );
  assert.equal(
    await shared.claimTransition(
      "task-2",
      { ...SCOPE, installationId: "installation-other" },
      "TASK_STATE_AUTH_REQUIRED",
      "a".repeat(64),
      "claim-wrong-scope",
    ),
    null,
  );
});

test("PlatformA2ATaskStore uses the current session token for every operation", async () => {
  const platform = createAuthoritativePlatform();
  let token = "session-one";
  const shared = store(platform.fetch, () => token);

  await shared.save(record("task-3"));
  token = "session-two";
  await shared.get("task-3", SCOPE);

  assert.deepEqual(platform.authorizationHeaders, [
    "Bearer session-one",
    "Bearer session-two",
  ]);
});

test("PlatformA2ATaskStore fails closed on Platform outage", async () => {
  const shared = store(async () => {
    throw new Error("backend details must not escape");
  });

  await assert.rejects(
    shared.get("task-4", SCOPE),
    (error: unknown) =>
      error instanceof PlatformA2ATaskStoreError &&
      error.code === "platform_a2a_transport_failed" &&
      !error.message.includes("backend details"),
  );
});

test("PlatformA2ATaskStore rejects mismatched claim responses", async () => {
  const shared = store(async () =>
    json({
      claim: {
        claimId: "other-claim",
        record: record("task-5"),
      },
    }),
  );

  await assert.rejects(
    shared.claimTransition(
      "task-5",
      SCOPE,
      "TASK_STATE_AUTH_REQUIRED",
      "a".repeat(64),
      "expected-claim",
    ),
    (error: unknown) =>
      error instanceof PlatformA2ATaskStoreError &&
      error.code === "invalid_platform_a2a_claim_binding_mismatch_response",
  );
});

test("PlatformA2ATaskStore rejects insecure remote HTTP by default", () => {
  assert.throws(
    () =>
      new PlatformA2ATaskStore({
        baseUrl: "http://platform.example",
        accessToken: () => "token",
      }),
    /requires HTTPS/i,
  );
});

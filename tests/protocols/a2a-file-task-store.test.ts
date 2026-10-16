import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FileA2ATaskStore } from "../../src/protocols/a2a/file-task-store.js";
import type {
  A2AStoredTask,
  A2ATaskScope,
} from "../../src/protocols/a2a/task-store.js";

const SCOPE: A2ATaskScope = {
  actor: "agent:finance",
  tenantId: "tenant-1",
  installationId: "installation-1",
};

function record(taskId: string, state = "TASK_STATE_AUTH_REQUIRED"): A2AStoredTask {
  return {
    task: {
      id: taskId,
      contextId: `context-${taskId}`,
      status: {
        state: state as A2AStoredTask["task"]["status"]["state"],
        timestamp: "2026-10-16T08:00:00.000Z",
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

async function withTempStore(
  run: (filePath: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "kab-a2a-task-store-"));
  try {
    await run(join(directory, "tasks.json"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("FileA2ATaskStore survives process-style re-instantiation", async () => {
  await withTempStore(async (filePath) => {
    const first = new FileA2ATaskStore({ filePath });
    await first.save(record("task-1"));

    const second = new FileA2ATaskStore({ filePath });
    assert.deepEqual(await second.get("task-1", SCOPE), record("task-1"));
    assert.equal(
      await second.get("task-1", { ...SCOPE, actor: "agent:other" }),
      null,
    );
  });
});

test("FileA2ATaskStore updates an existing unclaimed task without losing its security scope", async () => {
  await withTempStore(async (filePath) => {
    const store = new FileA2ATaskStore({ filePath });
    await store.save(record("task-1"));
    await store.save(record("task-1", "TASK_STATE_COMPLETED"));

    const restored = await new FileA2ATaskStore({ filePath }).get(
      "task-1",
      SCOPE,
    );
    assert.equal(restored?.task.status.state, "TASK_STATE_COMPLETED");
  });
});

test("durable transition claim is persisted before execution and blocks a second resume", async () => {
  await withTempStore(async (filePath) => {
    const first = new FileA2ATaskStore({ filePath });
    await first.save(record("task-1"));

    const claim = await first.claimTransition(
      "task-1",
      SCOPE,
      "TASK_STATE_AUTH_REQUIRED",
      "a".repeat(64),
      "claim-one",
    );
    assert.ok(claim);
    assert.equal(claim.record.task.status.state, "TASK_STATE_AUTH_REQUIRED");

    const afterRestart = new FileA2ATaskStore({ filePath });
    assert.equal(
      (await afterRestart.get("task-1", SCOPE))?.task.status.state,
      "TASK_STATE_WORKING",
    );
    assert.equal(
      await afterRestart.claimTransition(
        "task-1",
        SCOPE,
        "TASK_STATE_AUTH_REQUIRED",
        "a".repeat(64),
        "claim-two",
      ),
      null,
    );
    await assert.rejects(
      afterRestart.save(record("task-1", "TASK_STATE_COMPLETED")),
      /active transition claim/i,
    );
  });
});

test("durable transition completion requires the exact persisted claim", async () => {
  await withTempStore(async (filePath) => {
    const first = new FileA2ATaskStore({ filePath });
    await first.save(record("task-1"));
    const claim = await first.claimTransition(
      "task-1",
      SCOPE,
      "TASK_STATE_AUTH_REQUIRED",
      "a".repeat(64),
      "claim-one",
    );
    assert.ok(claim);

    const restarted = new FileA2ATaskStore({ filePath });
    assert.equal(
      await restarted.completeTransition(
        { ...claim, claimId: "wrong-claim" },
        record("task-1", "TASK_STATE_COMPLETED"),
      ),
      false,
    );
    assert.equal(
      await restarted.completeTransition(
        claim,
        record("task-1", "TASK_STATE_COMPLETED"),
      ),
      true,
    );
    assert.equal(
      (await restarted.get("task-1", SCOPE))?.task.status.state,
      "TASK_STATE_COMPLETED",
    );
  });
});

test("transition claim is bound to the exact action fingerprint", async () => {
  await withTempStore(async (filePath) => {
    const store = new FileA2ATaskStore({ filePath });
    await store.save(record("task-1"));

    assert.equal(
      await store.claimTransition(
        "task-1",
        SCOPE,
        "TASK_STATE_AUTH_REQUIRED",
        "b".repeat(64),
        "claim-wrong-action",
      ),
      null,
    );
    assert.equal(
      (await store.get("task-1", SCOPE))?.task.status.state,
      "TASK_STATE_AUTH_REQUIRED",
    );
  });
});

test("two concurrent in-process claims have exactly one winner", async () => {
  await withTempStore(async (filePath) => {
    const store = new FileA2ATaskStore({ filePath });
    await store.save(record("task-1"));

    const claims = await Promise.all([
      store.claimTransition(
        "task-1",
        SCOPE,
        "TASK_STATE_AUTH_REQUIRED",
        "a".repeat(64),
        "claim-a",
      ),
      store.claimTransition(
        "task-1",
        SCOPE,
        "TASK_STATE_AUTH_REQUIRED",
        "a".repeat(64),
        "claim-b",
      ),
    ]);
    assert.equal(claims.filter(Boolean).length, 1);
  });
});

test("FileA2ATaskStore migrates v1 state into v2 on the next write", async () => {
  await withTempStore(async (filePath) => {
    await writeFile(
      filePath,
      JSON.stringify({
        schemaVersion: "kab.a2a-task-store.v1",
        records: [record("task-1")],
      }),
      { mode: 0o600 },
    );

    const store = new FileA2ATaskStore({ filePath });
    assert.equal(
      (await store.get("task-1", SCOPE))?.task.status.state,
      "TASK_STATE_AUTH_REQUIRED",
    );
    await store.save(record("task-1", "TASK_STATE_COMPLETED"));

    const persisted = JSON.parse(await readFile(filePath, "utf8")) as {
      schemaVersion: string;
    };
    assert.equal(persisted.schemaVersion, "kab.a2a-task-store.v2");
  });
});

test("FileA2ATaskStore rejects task ID collisions across scopes", async () => {
  await withTempStore(async (filePath) => {
    const store = new FileA2ATaskStore({ filePath });
    await store.save(record("task-1"));

    const collision = record("task-1");
    collision.scope = { ...SCOPE, tenantId: "tenant-2" };

    await assert.rejects(
      store.save(collision),
      /collision across security scopes/i,
    );
  });
});

test("FileA2ATaskStore fails closed on corrupted persisted state", async () => {
  await withTempStore(async (filePath) => {
    await writeFile(filePath, "{broken-json", { mode: 0o600 });
    const store = new FileA2ATaskStore({ filePath });

    await assert.rejects(store.get("task-1", SCOPE), /corrupt/i);
  });
});

test("FileA2ATaskStore enforces the configured durable record bound", async () => {
  await withTempStore(async (filePath) => {
    const store = new FileA2ATaskStore({ filePath, maxRecords: 1 });
    await store.save(record("task-1"));

    await assert.rejects(
      store.save(record("task-2")),
      /record limit exceeded/i,
    );
  });
});

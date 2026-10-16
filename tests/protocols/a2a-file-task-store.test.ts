import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

test("FileA2ATaskStore updates an existing task without losing its security scope", async () => {
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

import assert from "node:assert/strict";
import test from "node:test";

import {
  ControlPlaneRuntimeCoordinator,
  type RuntimeReadiness,
} from "../../src/index.js";

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

function untilAborted(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    signal?.addEventListener("abort", () => resolve(), { once: true });
  });
}

test("control plane coordinator runs heartbeat and snapshot loops under one lifecycle", async () => {
  const controller = new AbortController();
  let readinessCalls = 0;
  let sessionStarted = false;
  let snapshotStarted = false;
  let sessionSignal: AbortSignal | undefined;
  let snapshotSignal: AbortSignal | undefined;

  const coordinator = new ControlPlaneRuntimeCoordinator(
    {
      async run(readinessProvider, signal) {
        sessionStarted = true;
        sessionSignal = signal;
        const readiness = await readinessProvider();
        assert.equal(readiness.readiness, "ready");
        await untilAborted(signal);
      },
    },
    {
      async run(signal) {
        snapshotStarted = true;
        snapshotSignal = signal;
        await untilAborted(signal);
      },
    },
  );

  const run = coordinator.run(() => {
    readinessCalls += 1;
    return {
      readiness: "ready",
      runtimeVersion: "0.1.0-dev.0",
      capabilities: ["connectors"],
    } satisfies RuntimeReadiness;
  }, controller.signal);

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(sessionStarted, true);
  assert.equal(snapshotStarted, true);
  assert.equal(readinessCalls, 1);
  assert.ok(sessionSignal);
  assert.equal(sessionSignal, snapshotSignal);

  controller.abort();
  await run;
  assert.equal(sessionSignal?.aborted, true);
});

test("unexpected session loop failure cancels snapshot loop and propagates the original error", async () => {
  const failure = new Error("control session invariant failed");
  let snapshotAborted = false;
  const stopped: Array<{ loop: string; reason: string }> = [];

  const coordinator = new ControlPlaneRuntimeCoordinator(
    {
      async run() {
        throw failure;
      },
    },
    {
      async run(signal) {
        await untilAborted(signal);
        snapshotAborted = signal?.aborted ?? false;
      },
    },
    {
      onLoopStopped(loop, reason) {
        stopped.push({ loop, reason });
      },
    },
  );

  await assert.rejects(
    () =>
      coordinator.run(() => ({
        readiness: "ready",
        runtimeVersion: "0.1.0-dev.0",
        capabilities: [],
      })),
    failure,
  );
  assert.equal(snapshotAborted, true);
  assert.deepEqual(stopped, [{ loop: "session", reason: "unexpected" }]);
});

test("unexpected snapshot loop failure cancels session loop without exposing a half-running runtime", async () => {
  const failure = new Error("snapshot scheduler invariant failed");
  let sessionAborted = false;

  const coordinator = new ControlPlaneRuntimeCoordinator(
    {
      async run(_readinessProvider, signal) {
        await untilAborted(signal);
        sessionAborted = signal?.aborted ?? false;
      },
    },
    {
      async run() {
        throw failure;
      },
    },
  );

  await assert.rejects(
    () =>
      coordinator.run(() => ({
        readiness: "degraded",
        runtimeVersion: "0.1.0-dev.0",
        capabilities: [],
      })),
    failure,
  );
  assert.equal(sessionAborted, true);
});

test("abort-shaped loop completion after coordinated cancellation is not surfaced as a failure", async () => {
  const controller = new AbortController();

  const coordinator = new ControlPlaneRuntimeCoordinator(
    {
      async run(_readinessProvider, signal) {
        if (signal?.aborted) throw abortError();
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(abortError()), {
            once: true,
          });
        });
      },
    },
    {
      async run(signal) {
        await untilAborted(signal);
      },
    },
  );

  const run = coordinator.run(() => ({
    readiness: "starting",
    runtimeVersion: "0.1.0-dev.0",
    capabilities: [],
  }), controller.signal);
  controller.abort();
  await run;
});

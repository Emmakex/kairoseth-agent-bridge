import assert from "node:assert/strict";
import test from "node:test";

import { ControlPlaneRuntimeCoordinator } from "../../src/index.js";

function untilAborted(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    signal?.addEventListener("abort", () => resolve(), { once: true });
  });
}

test("unexpected command-loop failure cancels session, snapshot, approval-key and audit siblings", async () => {
  const failure = new Error("command loop invariant failed");
  const aborted = new Set<string>();
  const sibling = (name: string) => ({
    async run(signal?: AbortSignal): Promise<void> {
      await untilAborted(signal);
      if (signal?.aborted) aborted.add(name);
    },
  });

  const coordinator = new ControlPlaneRuntimeCoordinator(
    {
      async run(_readinessProvider, signal) {
        await untilAborted(signal);
        if (signal?.aborted) aborted.add("session");
      },
    },
    sibling("snapshot"),
    {
      auxiliaryLoops: [
        { name: "approval_keys", loop: sibling("approval_keys") },
        {
          name: "commands",
          loop: {
            async run() {
              throw failure;
            },
          },
        },
        { name: "audit", loop: sibling("audit") },
      ],
    },
  );

  await assert.rejects(() => coordinator.run(() => "ready"), failure);
  assert.deepEqual(
    [...aborted].sort(),
    ["approval_keys", "audit", "session", "snapshot"],
  );
});

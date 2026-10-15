import type { RuntimeReadiness } from "../control-channel/session.js";

export interface ControlSessionRunLoop {
  run(
    readinessProvider: () => RuntimeReadiness | Promise<RuntimeReadiness>,
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface RuntimeBackgroundRunLoop {
  run(signal?: AbortSignal): Promise<void>;
}

export type ControlPlaneLoopName =
  | "session"
  | "snapshot"
  | "commands"
  | "approval_keys"
  | "audit";

export interface ControlPlaneAuxiliaryLoop {
  name: Exclude<ControlPlaneLoopName, "session" | "snapshot">;
  loop: RuntimeBackgroundRunLoop;
}

export interface ControlPlaneRuntimeCoordinatorOptions {
  auxiliaryLoops?: readonly ControlPlaneAuxiliaryLoop[] | undefined;
  onLoopStopped?:
    | ((loop: ControlPlaneLoopName, reason: "aborted" | "unexpected") => void)
    | undefined;
}

type LoopResult =
  | { loop: ControlPlaneLoopName; status: "fulfilled" }
  | { loop: ControlPlaneLoopName; status: "rejected"; error: unknown };

/**
 * Runs every long-lived Platform-facing control loop as one lifecycle.
 *
 * Individual schedulers own their recoverable transport retry/backoff policy.
 * This coordinator handles only process-level invariants: if any loop exits
 * unexpectedly, every sibling loop is cancelled so the runtime never remains
 * half-running with command, audit or security synchronization silently gone.
 */
export class ControlPlaneRuntimeCoordinator {
  constructor(
    private readonly sessionLoop: ControlSessionRunLoop,
    private readonly snapshotLoop: RuntimeBackgroundRunLoop,
    private readonly options: ControlPlaneRuntimeCoordinatorOptions = {},
  ) {}

  async run(
    readinessProvider: () => RuntimeReadiness | Promise<RuntimeReadiness>,
    signal?: AbortSignal,
  ): Promise<void> {
    const lifecycle = new AbortController();
    const detachExternalAbort = relayAbort(signal, lifecycle);

    if (signal?.aborted) {
      lifecycle.abort(signal.reason);
    }

    const tasks: Promise<LoopResult>[] = [
      settleLoop(
        "session",
        this.sessionLoop.run(readinessProvider, lifecycle.signal),
      ),
      settleLoop("snapshot", this.snapshotLoop.run(lifecycle.signal)),
      ...(this.options.auxiliaryLoops ?? []).map(({ name, loop }) =>
        settleLoop(name, loop.run(lifecycle.signal)),
      ),
    ];

    const first = await Promise.race(tasks);
    const alreadyAborted = lifecycle.signal.aborted;

    if (!alreadyAborted) {
      lifecycle.abort();
    }

    const results = await Promise.all(tasks);
    detachExternalAbort();

    if (alreadyAborted || signal?.aborted) {
      this.options.onLoopStopped?.(first.loop, "aborted");
      return;
    }

    const rejected =
      first.status === "rejected"
        ? first
        : results.find(
            (result): result is Extract<LoopResult, { status: "rejected" }> =>
              result.status === "rejected" && !isAbortError(result.error),
          );

    this.options.onLoopStopped?.(first.loop, "unexpected");

    if (rejected && !isAbortError(rejected.error)) {
      throw rejected.error;
    }

    throw new Error(
      `Control-plane ${first.loop} loop stopped unexpectedly without cancellation.`,
    );
  }
}

async function settleLoop(
  loop: ControlPlaneLoopName,
  task: Promise<void>,
): Promise<LoopResult> {
  try {
    await task;
    return { loop, status: "fulfilled" };
  } catch (error) {
    return { loop, status: "rejected", error };
  }
}

function relayAbort(
  external: AbortSignal | undefined,
  lifecycle: AbortController,
): () => void {
  if (!external) return () => undefined;

  const onAbort = () => lifecycle.abort(external.reason);
  external.addEventListener("abort", onAbort, { once: true });
  return () => external.removeEventListener("abort", onAbort);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

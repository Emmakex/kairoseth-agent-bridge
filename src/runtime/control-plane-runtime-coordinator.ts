import type { RuntimeReadiness } from "../control-channel/session.js";

export interface ControlSessionRunLoop {
  run(
    readinessProvider: () => RuntimeReadiness | Promise<RuntimeReadiness>,
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface RuntimeSnapshotRunLoop {
  run(signal?: AbortSignal): Promise<void>;
}

export interface ControlPlaneRuntimeCoordinatorOptions {
  onLoopStopped?:
    | ((loop: "session" | "snapshot", reason: "aborted" | "unexpected") => void)
    | undefined;
}

type LoopResult =
  | { loop: "session" | "snapshot"; status: "fulfilled" }
  | { loop: "session" | "snapshot"; status: "rejected"; error: unknown };

/**
 * Runs the long-lived Platform-facing control loops as one lifecycle.
 *
 * Session/heartbeat remains independent from snapshot reporting at the
 * operational level: RuntimeSnapshotScheduler handles report failures and
 * retries without invalidating the active control session. This coordinator
 * only prevents a programming/runtime failure from leaving one of the two
 * long-lived loops orphaned.
 */
export class ControlPlaneRuntimeCoordinator {
  constructor(
    private readonly sessionLoop: ControlSessionRunLoop,
    private readonly snapshotLoop: RuntimeSnapshotRunLoop,
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

    const sessionTask = settleLoop(
      "session",
      this.sessionLoop.run(readinessProvider, lifecycle.signal),
    );
    const snapshotTask = settleLoop(
      "snapshot",
      this.snapshotLoop.run(lifecycle.signal),
    );

    const first = await Promise.race([sessionTask, snapshotTask]);
    const alreadyAborted = lifecycle.signal.aborted;

    if (!alreadyAborted) {
      lifecycle.abort();
    }

    const results = await Promise.all([sessionTask, snapshotTask]);
    detachExternalAbort();

    if (alreadyAborted || signal?.aborted) {
      this.options.onLoopStopped?.(first.loop, "aborted");
      return;
    }

    const rejected =
      first.status === "rejected"
        ? first
        : results.find((result): result is Extract<LoopResult, { status: "rejected" }> =>
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
  loop: "session" | "snapshot",
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

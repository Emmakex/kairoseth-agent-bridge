import type { ControlSession } from "./session.js";
import type {
  RuntimeSnapshotAck,
  RuntimeSnapshotReporter,
} from "./runtime-snapshot.js";

export interface RuntimeSnapshotSessionSource {
  getCurrentSession(): ControlSession | null;
}

export interface RuntimeSnapshotSchedulerOptions {
  intervalMs?: number | undefined;
  noSessionDelayMs?: number | undefined;
  retryInitialDelayMs?: number | undefined;
  retryMaxDelayMs?: number | undefined;
  retryMultiplier?: number | undefined;
  sleep?: ((delayMs: number, signal?: AbortSignal) => Promise<void>) | undefined;
  onError?: ((error: unknown, retryDelayMs: number) => void) | undefined;
}

export interface RuntimeSnapshotSchedulerTickResult {
  reported: boolean;
  ack?: RuntimeSnapshotAck | undefined;
  sessionId?: string | undefined;
  reason?: "no_session" | "session_expired" | undefined;
}

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_NO_SESSION_DELAY_MS = 5_000;
const DEFAULT_RETRY_INITIAL_DELAY_MS = 5_000;
const DEFAULT_RETRY_MAX_DELAY_MS = 60_000;
const DEFAULT_RETRY_MULTIPLIER = 2;

export class RuntimeSnapshotScheduler {
  private readonly intervalMs: number;
  private readonly noSessionDelayMs: number;
  private readonly retryInitialDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly retryMultiplier: number;
  private readonly sleep: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  private retryAttempt = 0;

  constructor(
    private readonly sessionSource: RuntimeSnapshotSessionSource,
    private readonly reporter: RuntimeSnapshotReporter,
    private readonly options: RuntimeSnapshotSchedulerOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.noSessionDelayMs =
      options.noSessionDelayMs ?? DEFAULT_NO_SESSION_DELAY_MS;
    this.retryInitialDelayMs =
      options.retryInitialDelayMs ?? DEFAULT_RETRY_INITIAL_DELAY_MS;
    this.retryMaxDelayMs =
      options.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS;
    this.retryMultiplier =
      options.retryMultiplier ?? DEFAULT_RETRY_MULTIPLIER;
    this.sleep = options.sleep ?? sleepWithAbort;

    if (
      this.intervalMs < 10_000 ||
      this.intervalMs > 3_600_000 ||
      this.noSessionDelayMs < 1_000 ||
      this.noSessionDelayMs > 60_000 ||
      this.retryInitialDelayMs < 1_000 ||
      this.retryMaxDelayMs < this.retryInitialDelayMs ||
      this.retryMaxDelayMs > 300_000 ||
      this.retryMultiplier < 1 ||
      this.retryMultiplier > 10
    ) {
      throw new Error("Invalid runtime snapshot scheduler configuration.");
    }
  }

  async tick(): Promise<RuntimeSnapshotSchedulerTickResult> {
    const session = this.sessionSource.getCurrentSession();
    if (!session) {
      return { reported: false, reason: "no_session" };
    }
    if (session.isExpired()) {
      return { reported: false, reason: "session_expired" };
    }

    const ack = await this.reporter.report(session.credential.accessToken);
    this.retryAttempt = 0;
    return {
      reported: true,
      ack,
      sessionId: session.credential.sessionId,
    };
  }

  nextRetryDelayMs(): number {
    const delay = Math.min(
      this.retryMaxDelayMs,
      this.retryInitialDelayMs *
        this.retryMultiplier ** Math.max(0, this.retryAttempt),
    );
    this.retryAttempt += 1;
    return Math.round(delay);
  }

  resetBackoff(): void {
    this.retryAttempt = 0;
  }

  async run(signal?: AbortSignal): Promise<void> {
    while (!signal?.aborted) {
      try {
        const result = await this.tick();
        if (result.reported) {
          await this.sleep(this.intervalMs, signal);
        } else {
          this.retryAttempt = 0;
          await this.sleep(this.noSessionDelayMs, signal);
        }
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) return;
        const retryDelayMs = this.nextRetryDelayMs();
        this.options.onError?.(error, retryDelayMs);
        await this.sleep(retryDelayMs, signal);
      }
    }
  }
}

async function sleepWithAbort(
  delayMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return;

  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const error = new Error("Operation aborted.");
      error.name = "AbortError";
      reject(error);
    };

    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

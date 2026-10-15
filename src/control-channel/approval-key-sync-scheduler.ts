import {
  ApprovalKeySetSyncClient,
  type ApprovalKeySetTransport,
} from "./approval-key-sync.js";
import type { ApprovalKeySetManager } from "../security/approval-keys.js";
import type { ControlSession } from "./session.js";

export interface ApprovalKeySyncSessionSource {
  getCurrentSession(): ControlSession | null;
}

export interface ApprovalKeySyncSchedulerOptions {
  intervalMs?: number | undefined;
  noSessionDelayMs?: number | undefined;
  retryInitialDelayMs?: number | undefined;
  retryMaxDelayMs?: number | undefined;
  retryMultiplier?: number | undefined;
  sleep?: ((delayMs: number, signal?: AbortSignal) => Promise<void>) | undefined;
  onError?: ((error: unknown, retryDelayMs: number) => void) | undefined;
}

export type ApprovalKeySyncSchedulerTickResult =
  | { synced: false; reason: "no_session" | "session_expired" }
  | { synced: true; changed: boolean; generation: number };

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_NO_SESSION_DELAY_MS = 2_000;
const DEFAULT_RETRY_INITIAL_DELAY_MS = 2_000;
const DEFAULT_RETRY_MAX_DELAY_MS = 60_000;
const DEFAULT_RETRY_MULTIPLIER = 2;

export class ApprovalKeySyncScheduler {
  private readonly intervalMs: number;
  private readonly noSessionDelayMs: number;
  private readonly retryInitialDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly retryMultiplier: number;
  private readonly sleep: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  private retryAttempt = 0;

  constructor(
    private readonly sessionSource: ApprovalKeySyncSessionSource,
    private readonly manager: ApprovalKeySetManager,
    private readonly transport: ApprovalKeySetTransport,
    private readonly options: ApprovalKeySyncSchedulerOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.noSessionDelayMs = options.noSessionDelayMs ?? DEFAULT_NO_SESSION_DELAY_MS;
    this.retryInitialDelayMs =
      options.retryInitialDelayMs ?? DEFAULT_RETRY_INITIAL_DELAY_MS;
    this.retryMaxDelayMs = options.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS;
    this.retryMultiplier = options.retryMultiplier ?? DEFAULT_RETRY_MULTIPLIER;
    this.sleep = options.sleep ?? sleepWithAbort;

    validateDelay(this.intervalMs, 5_000, 3_600_000, "interval");
    validateDelay(this.noSessionDelayMs, 100, 60_000, "no-session delay");
    validateDelay(this.retryInitialDelayMs, 100, 60_000, "retry initial delay");
    validateDelay(
      this.retryMaxDelayMs,
      this.retryInitialDelayMs,
      300_000,
      "retry max delay",
    );
    if (this.retryMultiplier < 1 || this.retryMultiplier > 10) {
      throw new Error("Approval key sync retry multiplier must be between 1 and 10.");
    }
  }

  async tick(): Promise<ApprovalKeySyncSchedulerTickResult> {
    const session = this.sessionSource.getCurrentSession();
    if (!session) return { synced: false, reason: "no_session" };
    if (session.isExpired()) return { synced: false, reason: "session_expired" };

    const result = await new ApprovalKeySetSyncClient(
      session,
      this.manager,
      this.transport,
    ).syncOnce();
    this.retryAttempt = 0;
    return { synced: true, ...result };
  }

  nextRetryDelayMs(): number {
    const delay = Math.min(
      this.retryMaxDelayMs,
      this.retryInitialDelayMs * this.retryMultiplier ** Math.max(0, this.retryAttempt),
    );
    this.retryAttempt += 1;
    return Math.round(delay);
  }

  async run(signal?: AbortSignal): Promise<void> {
    while (!signal?.aborted) {
      try {
        const result = await this.tick();
        if (!result.synced) {
          this.retryAttempt = 0;
          await this.sleep(this.noSessionDelayMs, signal);
        } else {
          await this.sleep(this.intervalMs, signal);
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

function validateDelay(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): void {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(
      `Approval key sync ${label} must be between ${minimum}ms and ${maximum}ms.`,
    );
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

import {
  AuditDeliveryClient,
  type AuditDeliveryTransport,
} from "./audit-delivery.js";
import type { AuditOutboxStore } from "../audit/outbox.js";
import type { ControlSession } from "./session.js";

export interface AuditDeliverySessionSource {
  getCurrentSession(): ControlSession | null;
}

export interface AuditDeliverySchedulerOptions {
  activeDelayMs?: number | undefined;
  idleDelayMs?: number | undefined;
  noSessionDelayMs?: number | undefined;
  retryInitialDelayMs?: number | undefined;
  retryMaxDelayMs?: number | undefined;
  retryMultiplier?: number | undefined;
  maxBatchSize?: number | undefined;
  sleep?: ((delayMs: number, signal?: AbortSignal) => Promise<void>) | undefined;
  onError?: ((error: unknown, retryDelayMs: number) => void) | undefined;
}

export type AuditDeliverySchedulerTickResult =
  | {
      delivered: false;
      reason: "no_session" | "session_expired";
      sent: 0;
      acknowledged: 0;
      remaining: number;
    }
  | {
      delivered: true;
      sent: number;
      acknowledged: number;
      remaining: number;
    };

const DEFAULT_ACTIVE_DELAY_MS = 250;
const DEFAULT_IDLE_DELAY_MS = 2_000;
const DEFAULT_NO_SESSION_DELAY_MS = 2_000;
const DEFAULT_RETRY_INITIAL_DELAY_MS = 1_000;
const DEFAULT_RETRY_MAX_DELAY_MS = 30_000;
const DEFAULT_RETRY_MULTIPLIER = 2;

export class AuditDeliveryScheduler {
  private readonly activeDelayMs: number;
  private readonly idleDelayMs: number;
  private readonly noSessionDelayMs: number;
  private readonly retryInitialDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly retryMultiplier: number;
  private readonly maxBatchSize: number;
  private readonly sleep: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  private retryAttempt = 0;

  constructor(
    private readonly sessionSource: AuditDeliverySessionSource,
    private readonly outbox: AuditOutboxStore,
    private readonly transport: AuditDeliveryTransport,
    private readonly options: AuditDeliverySchedulerOptions = {},
  ) {
    this.activeDelayMs = options.activeDelayMs ?? DEFAULT_ACTIVE_DELAY_MS;
    this.idleDelayMs = options.idleDelayMs ?? DEFAULT_IDLE_DELAY_MS;
    this.noSessionDelayMs = options.noSessionDelayMs ?? DEFAULT_NO_SESSION_DELAY_MS;
    this.retryInitialDelayMs =
      options.retryInitialDelayMs ?? DEFAULT_RETRY_INITIAL_DELAY_MS;
    this.retryMaxDelayMs = options.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS;
    this.retryMultiplier = options.retryMultiplier ?? DEFAULT_RETRY_MULTIPLIER;
    this.maxBatchSize = options.maxBatchSize ?? 100;
    this.sleep = options.sleep ?? sleepWithAbort;

    validateDelay(this.activeDelayMs, 50, 60_000, "active delay");
    validateDelay(this.idleDelayMs, 100, 300_000, "idle delay");
    validateDelay(this.noSessionDelayMs, 100, 60_000, "no-session delay");
    validateDelay(this.retryInitialDelayMs, 100, 60_000, "retry initial delay");
    validateDelay(
      this.retryMaxDelayMs,
      this.retryInitialDelayMs,
      300_000,
      "retry max delay",
    );
    if (this.retryMultiplier < 1 || this.retryMultiplier > 10) {
      throw new Error("Audit delivery retry multiplier must be between 1 and 10.");
    }
    if (!Number.isInteger(this.maxBatchSize) || this.maxBatchSize < 1 || this.maxBatchSize > 500) {
      throw new Error("Audit delivery batch size must be between 1 and 500.");
    }
  }

  async tick(): Promise<AuditDeliverySchedulerTickResult> {
    const session = this.sessionSource.getCurrentSession();
    const remaining = await this.outbox.size();
    if (!session) {
      return {
        delivered: false,
        reason: "no_session",
        sent: 0,
        acknowledged: 0,
        remaining,
      };
    }
    if (session.isExpired()) {
      return {
        delivered: false,
        reason: "session_expired",
        sent: 0,
        acknowledged: 0,
        remaining,
      };
    }

    const result = await new AuditDeliveryClient(
      session,
      this.outbox,
      this.transport,
      { maxBatchSize: this.maxBatchSize },
    ).flushOnce();
    this.retryAttempt = 0;
    return {
      delivered: true,
      sent: result.sent,
      acknowledged: result.acknowledged,
      remaining: result.remaining,
    };
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
        if (!result.delivered) {
          this.retryAttempt = 0;
          await this.sleep(this.noSessionDelayMs, signal);
          continue;
        }
        const delayMs =
          result.sent > 0 || result.remaining > 0
            ? this.activeDelayMs
            : this.idleDelayMs;
        await this.sleep(delayMs, signal);
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
      `Audit delivery ${label} must be between ${minimum}ms and ${maximum}ms.`,
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

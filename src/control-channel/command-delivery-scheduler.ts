import {
  CommandDeliveryClient,
  type CommandDrainResult,
  type OutboundCommandTransport,
} from "./command-delivery.js";
import type { CommandProcessor } from "./command.js";
import type { ControlSession } from "./session.js";

export interface CommandDeliverySessionSource {
  getCurrentSession(): ControlSession | null;
}

export interface CommandDeliverySchedulerOptions {
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

export type CommandDeliverySchedulerTickResult =
  | {
      polled: false;
      reason: "no_session" | "session_expired";
      acknowledgements: 0;
    }
  | {
      polled: true;
      batchId: string;
      acknowledgements: number;
    };

const DEFAULT_ACTIVE_DELAY_MS = 250;
const DEFAULT_IDLE_DELAY_MS = 2_000;
const DEFAULT_NO_SESSION_DELAY_MS = 2_000;
const DEFAULT_RETRY_INITIAL_DELAY_MS = 1_000;
const DEFAULT_RETRY_MAX_DELAY_MS = 30_000;
const DEFAULT_RETRY_MULTIPLIER = 2;

export class CommandDeliveryScheduler {
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
    private readonly sessionSource: CommandDeliverySessionSource,
    private readonly transport: OutboundCommandTransport,
    private readonly processor: CommandProcessor,
    private readonly options: CommandDeliverySchedulerOptions = {},
  ) {
    this.activeDelayMs = options.activeDelayMs ?? DEFAULT_ACTIVE_DELAY_MS;
    this.idleDelayMs = options.idleDelayMs ?? DEFAULT_IDLE_DELAY_MS;
    this.noSessionDelayMs = options.noSessionDelayMs ?? DEFAULT_NO_SESSION_DELAY_MS;
    this.retryInitialDelayMs =
      options.retryInitialDelayMs ?? DEFAULT_RETRY_INITIAL_DELAY_MS;
    this.retryMaxDelayMs = options.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS;
    this.retryMultiplier = options.retryMultiplier ?? DEFAULT_RETRY_MULTIPLIER;
    this.maxBatchSize = options.maxBatchSize ?? 10;
    this.sleep = options.sleep ?? sleepWithAbort;

    validateDelay(this.activeDelayMs, 50, 60_000, "active delay");
    validateDelay(this.idleDelayMs, 100, 300_000, "idle delay");
    validateDelay(this.noSessionDelayMs, 100, 60_000, "no-session delay");
    validateDelay(this.retryInitialDelayMs, 100, 60_000, "retry initial delay");
    validateDelay(this.retryMaxDelayMs, this.retryInitialDelayMs, 300_000, "retry max delay");

    if (this.retryMultiplier < 1 || this.retryMultiplier > 10) {
      throw new Error("Command delivery retry multiplier must be between 1 and 10.");
    }
    if (!Number.isInteger(this.maxBatchSize) || this.maxBatchSize < 1 || this.maxBatchSize > 100) {
      throw new Error("Command delivery batch size must be between 1 and 100.");
    }
  }

  async tick(): Promise<CommandDeliverySchedulerTickResult> {
    const session = this.sessionSource.getCurrentSession();
    if (!session) {
      return { polled: false, reason: "no_session", acknowledgements: 0 };
    }
    if (session.isExpired()) {
      return { polled: false, reason: "session_expired", acknowledgements: 0 };
    }

    const client = new CommandDeliveryClient(
      session,
      this.transport,
      this.processor,
      { maxBatchSize: this.maxBatchSize },
    );
    const result = await client.drainOnce();
    this.retryAttempt = 0;
    return toTickResult(result);
  }

  nextRetryDelayMs(): number {
    const delay = Math.min(
      this.retryMaxDelayMs,
      this.retryInitialDelayMs * this.retryMultiplier ** Math.max(0, this.retryAttempt),
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
        if (!result.polled) {
          this.retryAttempt = 0;
          await this.sleep(this.noSessionDelayMs, signal);
          continue;
        }

        const delayMs =
          result.acknowledgements > 0 ? this.activeDelayMs : this.idleDelayMs;
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

function toTickResult(result: CommandDrainResult): CommandDeliverySchedulerTickResult {
  return {
    polled: true,
    batchId: result.batchId,
    acknowledgements: result.acknowledgements.length,
  };
}

function validateDelay(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): void {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`Command delivery ${label} must be between ${minimum}ms and ${maximum}ms.`);
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

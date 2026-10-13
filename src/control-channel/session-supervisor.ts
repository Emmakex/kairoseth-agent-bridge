import type { InstallationBindingManager } from "./installation-binding.js";
import {
  ControlSession,
  ControlSessionClient,
  type HeartbeatAck,
  type RuntimeReadiness,
} from "./session.js";

export interface SessionBackoffOptions {
  initialDelayMs?: number | undefined;
  maxDelayMs?: number | undefined;
  multiplier?: number | undefined;
  jitterRatio?: number | undefined;
}

export interface ControlSessionSupervisorOptions {
  renewBeforeMs?: number | undefined;
  backoff?: SessionBackoffOptions | undefined;
  now?: (() => Date) | undefined;
  sleep?: ((delayMs: number, signal?: AbortSignal) => Promise<void>) | undefined;
  random?: (() => number) | undefined;
  onError?: ((error: unknown, retryDelayMs: number) => void) | undefined;
}

export interface SupervisorTickResult {
  ack: HeartbeatAck;
  sessionId: string;
  renewed: boolean;
}

interface NormalizedBackoffOptions {
  initialDelayMs: number;
  maxDelayMs: number;
  multiplier: number;
  jitterRatio: number;
}

const DEFAULT_RENEW_BEFORE_MS = 60_000;
const DEFAULT_BACKOFF: NormalizedBackoffOptions = {
  initialDelayMs: 1_000,
  maxDelayMs: 30_000,
  multiplier: 2,
  jitterRatio: 0.2,
};

export class ControlSessionSupervisor {
  private readonly renewBeforeMs: number;
  private readonly backoff: NormalizedBackoffOptions;
  private readonly now: () => Date;
  private readonly sleep: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  private readonly random: () => number;
  private currentSession: ControlSession | null = null;
  private retryAttempt = 0;

  constructor(
    private readonly bindingManager: InstallationBindingManager,
    private readonly sessionClient: ControlSessionClient,
    private readonly options: ControlSessionSupervisorOptions = {},
  ) {
    this.renewBeforeMs = options.renewBeforeMs ?? DEFAULT_RENEW_BEFORE_MS;
    this.backoff = normalizeBackoff(options.backoff);
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? sleepWithAbort;
    this.random = options.random ?? Math.random;

    if (this.renewBeforeMs < 0) {
      throw new Error("Session renew-before window cannot be negative.");
    }
  }

  async tick(readiness: RuntimeReadiness): Promise<SupervisorTickResult> {
    const binding = await this.bindingManager.require();
    let renewed = false;

    if (!this.currentSession || this.shouldRenew(this.currentSession)) {
      this.currentSession = await this.sessionClient.open(binding);
      renewed = true;
    }

    try {
      const ack = await this.currentSession.heartbeat(readiness);
      const sessionId = this.currentSession.credential.sessionId;
      this.retryAttempt = 0;

      return { ack, sessionId, renewed };
    } catch (error) {
      this.currentSession = null;
      throw error;
    }
  }

  invalidateSession(): void {
    this.currentSession = null;
  }

  getCurrentSession(): ControlSession | null {
    return this.currentSession;
  }

  nextReconnectDelayMs(): number {
    const delay = calculateReconnectDelayMs(
      this.retryAttempt,
      this.backoff,
      this.random,
    );
    this.retryAttempt += 1;
    return delay;
  }

  resetBackoff(): void {
    this.retryAttempt = 0;
  }

  async run(
    readinessProvider: () => RuntimeReadiness | Promise<RuntimeReadiness>,
    signal?: AbortSignal,
  ): Promise<void> {
    while (!signal?.aborted) {
      try {
        const readiness = await readinessProvider();
        const result = await this.tick(readiness);
        const session = this.currentSession;

        if (!session) {
          throw new Error("Control session disappeared after successful heartbeat.");
        }

        const delayMs = heartbeatDelayMs(session, result.ack);
        await this.sleep(delayMs, signal);
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) {
          return;
        }

        this.currentSession = null;
        const retryDelayMs = this.nextReconnectDelayMs();
        this.options.onError?.(error, retryDelayMs);
        await this.sleep(retryDelayMs, signal);
      }
    }
  }

  private shouldRenew(session: ControlSession): boolean {
    const expiresAt = Date.parse(session.credential.expiresAt);
    return expiresAt - this.now().getTime() <= this.renewBeforeMs;
  }
}

export function calculateReconnectDelayMs(
  attempt: number,
  options: SessionBackoffOptions = {},
  random: () => number = Math.random,
): number {
  const normalized = normalizeBackoff(options);
  const exponential = Math.min(
    normalized.maxDelayMs,
    normalized.initialDelayMs * normalized.multiplier ** Math.max(0, attempt),
  );
  const jitterRange = exponential * normalized.jitterRatio;
  const jitter = (random() * 2 - 1) * jitterRange;

  return Math.max(0, Math.round(exponential + jitter));
}

function normalizeBackoff(
  options: SessionBackoffOptions | undefined,
): NormalizedBackoffOptions {
  const normalized: NormalizedBackoffOptions = {
    initialDelayMs: options?.initialDelayMs ?? DEFAULT_BACKOFF.initialDelayMs,
    maxDelayMs: options?.maxDelayMs ?? DEFAULT_BACKOFF.maxDelayMs,
    multiplier: options?.multiplier ?? DEFAULT_BACKOFF.multiplier,
    jitterRatio: options?.jitterRatio ?? DEFAULT_BACKOFF.jitterRatio,
  };

  if (
    normalized.initialDelayMs <= 0 ||
    normalized.maxDelayMs < normalized.initialDelayMs ||
    normalized.multiplier < 1 ||
    normalized.jitterRatio < 0 ||
    normalized.jitterRatio > 1
  ) {
    throw new Error("Invalid control session reconnect backoff configuration.");
  }

  return normalized;
}

function heartbeatDelayMs(session: ControlSession, ack: HeartbeatAck): number {
  const seconds =
    ack.nextHeartbeatInSeconds ?? session.credential.heartbeatIntervalSeconds;

  if (!Number.isFinite(seconds) || seconds < 1) {
    throw new Error("Heartbeat acknowledgement interval is invalid.");
  }

  return Math.round(seconds * 1_000);
}

async function sleepWithAbort(
  delayMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    return;
  }

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

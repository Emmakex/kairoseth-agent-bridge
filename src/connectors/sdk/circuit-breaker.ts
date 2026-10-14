import { ConnectorError } from "./errors.js";

export type ConnectorCircuitState = "closed" | "open" | "half-open";

export interface ConnectorCircuitBreakerOptions {
  failureThreshold?: number | undefined;
  resetTimeoutMs?: number | undefined;
  now?: (() => Date) | undefined;
}

export interface ConnectorCircuitSnapshot {
  state: ConnectorCircuitState;
  consecutiveFailures: number;
  openedAt?: string | undefined;
  retryAt?: string | undefined;
  probeInFlight: boolean;
}

interface CircuitStateRecord {
  state: ConnectorCircuitState;
  consecutiveFailures: number;
  openedAt?: number | undefined;
  retryAt?: number | undefined;
  probeInFlight: boolean;
}

const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_RESET_TIMEOUT_MS = 30_000;

export class ConnectorCircuitOpenError extends ConnectorError {
  constructor(
    readonly circuitKey: string,
    readonly retryAt: string,
  ) {
    super(`Connector circuit ${circuitKey} is open until ${retryAt}.`);
    this.name = "ConnectorCircuitOpenError";
  }
}

/**
 * Per-process circuit breaker baseline. The caller chooses the key, normally
 * connector + instance + tool. Shared breaker state can be introduced later
 * behind the same high-level semantics when a deployment needs it.
 */
export class ConnectorCircuitBreaker {
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly now: () => Date;
  private readonly circuits = new Map<string, CircuitStateRecord>();

  constructor(options: ConnectorCircuitBreakerOptions = {}) {
    this.failureThreshold =
      options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.resetTimeoutMs = options.resetTimeoutMs ?? DEFAULT_RESET_TIMEOUT_MS;
    this.now = options.now ?? (() => new Date());

    if (
      !Number.isInteger(this.failureThreshold) ||
      this.failureThreshold < 1 ||
      this.failureThreshold > 1000
    ) {
      throw new Error("Circuit-breaker failure threshold must be between 1 and 1000.");
    }
    if (
      !Number.isInteger(this.resetTimeoutMs) ||
      this.resetTimeoutMs < 100 ||
      this.resetTimeoutMs > 24 * 60 * 60 * 1_000
    ) {
      throw new Error("Circuit-breaker reset timeout must be between 100 and 86400000 ms.");
    }
  }

  /** Reserve permission to call the backend or throw while the circuit is open. */
  beforeRequest(key: string): void {
    const normalizedKey = validateKey(key);
    const now = this.timestamp();
    const record = this.circuits.get(normalizedKey);
    if (!record || record.state === "closed") return;

    if (record.state === "open") {
      if (record.retryAt !== undefined && now >= record.retryAt) {
        record.state = "half-open";
        record.probeInFlight = true;
        this.circuits.set(normalizedKey, record);
        return;
      }
      throw new ConnectorCircuitOpenError(
        normalizedKey,
        new Date(record.retryAt ?? now + this.resetTimeoutMs).toISOString(),
      );
    }

    if (record.probeInFlight) {
      throw new ConnectorCircuitOpenError(
        normalizedKey,
        new Date(record.retryAt ?? now + this.resetTimeoutMs).toISOString(),
      );
    }
    record.probeInFlight = true;
    this.circuits.set(normalizedKey, record);
  }

  recordSuccess(key: string): void {
    const normalizedKey = validateKey(key);
    this.circuits.set(normalizedKey, {
      state: "closed",
      consecutiveFailures: 0,
      probeInFlight: false,
    });
  }

  /** Record one final transient/backend failure after any internal retries. */
  recordFailure(key: string): void {
    const normalizedKey = validateKey(key);
    const now = this.timestamp();
    const current = this.circuits.get(normalizedKey) ?? {
      state: "closed" as const,
      consecutiveFailures: 0,
      probeInFlight: false,
    };

    if (current.state === "half-open") {
      this.open(current, now);
      this.circuits.set(normalizedKey, current);
      return;
    }

    current.consecutiveFailures += 1;
    current.probeInFlight = false;
    if (current.consecutiveFailures >= this.failureThreshold) {
      this.open(current, now);
    }
    this.circuits.set(normalizedKey, current);
  }

  snapshot(key: string): ConnectorCircuitSnapshot {
    const normalizedKey = validateKey(key);
    const record = this.circuits.get(normalizedKey) ?? {
      state: "closed" as const,
      consecutiveFailures: 0,
      probeInFlight: false,
    };
    return {
      state: record.state,
      consecutiveFailures: record.consecutiveFailures,
      ...(record.openedAt !== undefined
        ? { openedAt: new Date(record.openedAt).toISOString() }
        : {}),
      ...(record.retryAt !== undefined
        ? { retryAt: new Date(record.retryAt).toISOString() }
        : {}),
      probeInFlight: record.probeInFlight,
    };
  }

  reset(key: string): void {
    this.circuits.delete(validateKey(key));
  }

  private open(record: CircuitStateRecord, now: number): void {
    record.state = "open";
    record.openedAt = now;
    record.retryAt = now + this.resetTimeoutMs;
    record.probeInFlight = false;
  }

  private timestamp(): number {
    const value = this.now();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new Error("Circuit-breaker clock returned an invalid Date.");
    }
    return value.getTime();
  }
}

export function connectorCircuitKey(
  connectorId: string,
  connectorInstanceId: string,
  toolId: string,
): string {
  return `${validateKey(connectorId)}:${validateKey(connectorInstanceId)}:${validateKey(toolId)}`;
}

function validateKey(value: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 512 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error("Connector circuit key is invalid.");
  }
  return value;
}

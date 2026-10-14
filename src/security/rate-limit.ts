export interface RateLimitConsumeRequest {
  version: "kab.rate-limit-consume.v1";
  key: string;
  limit: number;
  windowMs: number;
  now: string;
}

export interface RateLimitConsumeResult {
  allowed: boolean;
  remaining: number;
  resetAt: string;
}

/**
 * Shared rate-limit state contract.
 *
 * `consume()` MUST atomically test and increment one fixed-window counter.
 * Clustered implementations must perform this operation in the shared backend
 * (for example Redis Lua/transaction, MongoDB conditional update, or SQL row
 * locking/upsert). A separate read followed by write is not safe.
 */
export interface RateLimitStore {
  consume(request: RateLimitConsumeRequest): Promise<RateLimitConsumeResult>;
  prune(now: Date): Promise<number>;
}

interface FixedWindowState {
  windowStartedAt: number;
  count: number;
  windowMs: number;
}

/** Single-process baseline for tests/local runtimes. */
export class InMemoryFixedWindowRateLimitStore implements RateLimitStore {
  private readonly counters = new Map<string, FixedWindowState>();

  async consume(request: RateLimitConsumeRequest): Promise<RateLimitConsumeResult> {
    validateRequest(request);
    const now = Date.parse(request.now);
    const existing = this.counters.get(request.key);
    const expired =
      !existing ||
      existing.windowMs !== request.windowMs ||
      now >= existing.windowStartedAt + existing.windowMs;

    const state: FixedWindowState = expired
      ? { windowStartedAt: now, count: 0, windowMs: request.windowMs }
      : existing;

    const allowed = state.count < request.limit;
    if (allowed) state.count += 1;
    this.counters.set(request.key, state);

    return {
      allowed,
      remaining: Math.max(0, request.limit - state.count),
      resetAt: new Date(state.windowStartedAt + state.windowMs).toISOString(),
    };
  }

  async prune(now: Date): Promise<number> {
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      throw new Error("Rate-limit prune time is invalid.");
    }
    let removed = 0;
    for (const [key, state] of this.counters.entries()) {
      if (now.getTime() >= state.windowStartedAt + state.windowMs) {
        this.counters.delete(key);
        removed += 1;
      }
    }
    return removed;
  }
}

function validateRequest(request: RateLimitConsumeRequest): void {
  if (
    request.version !== "kab.rate-limit-consume.v1" ||
    typeof request.key !== "string" ||
    request.key.length < 1 ||
    request.key.length > 1024 ||
    /[\u0000-\u001f\u007f]/.test(request.key)
  ) {
    throw new Error("Rate-limit key is invalid.");
  }
  if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 1_000_000) {
    throw new Error("Rate-limit request limit is invalid.");
  }
  if (
    !Number.isInteger(request.windowMs) ||
    request.windowMs < 1_000 ||
    request.windowMs > 24 * 60 * 60 * 1_000
  ) {
    throw new Error("Rate-limit window is invalid.");
  }
  const now = Date.parse(request.now);
  if (!Number.isFinite(now)) {
    throw new Error("Rate-limit request time is invalid.");
  }
}

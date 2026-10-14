import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { canonicalJson } from "../security/canonical-json.js";
import type { RateLimitStore } from "../security/rate-limit.js";
import type {
  InvocationContext,
  PolicyDecision,
  PolicyEvaluator,
  RiskLevel,
  ToolDefinition,
} from "./contracts.js";

export type RateLimitScope =
  | "tenant"
  | "installation"
  | "actor"
  | "tool"
  | "actor-tool"
  | "installation-tool";

export interface InvocationRateLimitRule {
  id: string;
  limit: number;
  windowMs: number;
  scope: RateLimitScope;
  risks?: readonly RiskLevel[] | undefined;
}

export interface AdmissionControlPolicyOptions {
  /** Default canonical JSON input limit. Defaults to 1 MiB. */
  maxPayloadBytes?: number | undefined;
  /** Exact tool ID overrides for inputs that legitimately require another bound. */
  toolPayloadLimits?: Readonly<Record<string, number>> | undefined;
  rateLimits?: readonly InvocationRateLimitRule[] | undefined;
  now?: (() => Date) | undefined;
  /** Secure default: a configured rate-limit store failure denies the invocation. */
  failClosedOnRateLimitError?: boolean | undefined;
}

const DEFAULT_MAX_PAYLOAD_BYTES = 1024 * 1024;
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;

/**
 * Protocol-neutral admission wrapper. Payload/rate controls run before the
 * underlying authorization policy. Passing admission never grants access: the
 * wrapped policy still decides ALLOW / DENY / REQUIRE_APPROVAL.
 */
export class AdmissionControlPolicyEvaluator implements PolicyEvaluator {
  private readonly maxPayloadBytes: number;
  private readonly toolPayloadLimits: Readonly<Record<string, number>>;
  private readonly rateLimits: readonly InvocationRateLimitRule[];
  private readonly now: () => Date;
  private readonly failClosedOnRateLimitError: boolean;

  constructor(
    private readonly basePolicy: PolicyEvaluator,
    private readonly rateLimitStore: RateLimitStore | null,
    options: AdmissionControlPolicyOptions = {},
  ) {
    this.maxPayloadBytes = validatePayloadLimit(
      options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
      "default payload limit",
    );
    this.toolPayloadLimits = normalizeToolPayloadLimits(
      options.toolPayloadLimits ?? {},
    );
    this.rateLimits = (options.rateLimits ?? []).map(normalizeRule);
    this.now = options.now ?? (() => new Date());
    this.failClosedOnRateLimitError =
      options.failClosedOnRateLimitError ?? true;

    if (this.rateLimits.length > 0 && !this.rateLimitStore) {
      throw new Error("Configured invocation rate limits require a RateLimitStore.");
    }
  }

  async evaluate(
    tool: ToolDefinition,
    input: unknown,
    context: InvocationContext,
  ): Promise<PolicyDecision> {
    const payloadDecision = this.checkPayload(tool, input);
    if (payloadDecision) return payloadDecision;

    const rateDecision = await this.checkRateLimits(tool, context);
    if (rateDecision) return rateDecision;

    return this.basePolicy.evaluate(tool, input, context);
  }

  private checkPayload(
    tool: ToolDefinition,
    input: unknown,
  ): PolicyDecision | null {
    const limit = this.toolPayloadLimits[tool.id] ?? this.maxPayloadBytes;
    let encoded: string;
    try {
      encoded = canonicalJson(input);
    } catch {
      return {
        outcome: "DENY",
        reason: "Invocation input is not valid canonical JSON.",
      };
    }

    const bytes = Buffer.byteLength(encoded, "utf8");
    if (bytes > limit) {
      return {
        outcome: "DENY",
        reason: `Invocation payload exceeds the configured ${limit}-byte limit.`,
      };
    }
    return null;
  }

  private async checkRateLimits(
    tool: ToolDefinition,
    context: InvocationContext,
  ): Promise<PolicyDecision | null> {
    if (this.rateLimits.length === 0) return null;
    const now = this.currentTime();

    for (const rule of this.rateLimits) {
      if (rule.risks && !rule.risks.includes(tool.risk)) continue;

      const scope = scopeFor(rule.scope, tool, context);
      if (!scope) {
        return {
          outcome: "DENY",
          reason: `Rate-limit rule ${rule.id} requires trusted scope that is unavailable.`,
        };
      }

      try {
        const result = await this.rateLimitStore!.consume({
          version: "kab.rate-limit-consume.v1",
          key: rateKey(rule.id, scope),
          limit: rule.limit,
          windowMs: rule.windowMs,
          now: now.toISOString(),
        });
        if (!result.allowed) {
          return {
            outcome: "DENY",
            reason: `Invocation rate limit ${rule.id} exceeded until ${result.resetAt}.`,
          };
        }
      } catch {
        if (this.failClosedOnRateLimitError) {
          return {
            outcome: "DENY",
            reason: `Invocation rate limiting is unavailable for rule ${rule.id}.`,
          };
        }
      }
    }

    return null;
  }

  private currentTime(): Date {
    const value = this.now();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new Error("Admission-control clock returned an invalid Date.");
    }
    return value;
  }
}

function scopeFor(
  scope: RateLimitScope,
  tool: ToolDefinition,
  context: InvocationContext,
): string | null {
  switch (scope) {
    case "tenant":
      return context.tenantId ? `tenant:${context.tenantId}` : null;
    case "installation":
      return context.installationId
        ? `installation:${context.installationId}`
        : null;
    case "actor":
      return context.actor ? `actor:${context.actor}` : null;
    case "tool":
      return `tool:${tool.id}`;
    case "actor-tool":
      return context.actor
        ? `actor:${context.actor}|tool:${tool.id}`
        : null;
    case "installation-tool":
      return context.installationId
        ? `installation:${context.installationId}|tool:${tool.id}`
        : null;
  }
}

function rateKey(ruleId: string, scope: string): string {
  const digest = createHash("sha256")
    .update(`kab.rate-limit.v1|${ruleId}|${scope}`, "utf8")
    .digest("base64url");
  return `kabrl:${ruleId}:${digest}`;
}

function normalizeRule(rule: InvocationRateLimitRule): InvocationRateLimitRule {
  if (
    !rule ||
    typeof rule.id !== "string" ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(rule.id)
  ) {
    throw new Error("Invocation rate-limit rule ID is invalid.");
  }
  if (!Number.isInteger(rule.limit) || rule.limit < 1 || rule.limit > 1_000_000) {
    throw new Error(`Invocation rate-limit rule ${rule.id} limit is invalid.`);
  }
  if (
    !Number.isInteger(rule.windowMs) ||
    rule.windowMs < 1_000 ||
    rule.windowMs > 24 * 60 * 60 * 1_000
  ) {
    throw new Error(`Invocation rate-limit rule ${rule.id} window is invalid.`);
  }
  if (!isScope(rule.scope)) {
    throw new Error(`Invocation rate-limit rule ${rule.id} scope is invalid.`);
  }
  const risks = rule.risks ? [...new Set(rule.risks)] : undefined;
  if (risks?.some((risk) => !isRisk(risk))) {
    throw new Error(`Invocation rate-limit rule ${rule.id} risk set is invalid.`);
  }
  return {
    id: rule.id,
    limit: rule.limit,
    windowMs: rule.windowMs,
    scope: rule.scope,
    ...(risks ? { risks } : {}),
  };
}

function normalizeToolPayloadLimits(
  values: Readonly<Record<string, number>>,
): Readonly<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const [toolId, value] of Object.entries(values)) {
    if (!toolId || toolId.length > 128 || /[\u0000-\u001f\u007f]/.test(toolId)) {
      throw new Error("Tool payload limit contains an invalid tool ID.");
    }
    result[toolId] = validatePayloadLimit(value, `payload limit for ${toolId}`);
  }
  return result;
}

function validatePayloadLimit(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_PAYLOAD_BYTES) {
    throw new Error(`${label} must be an integer between 1 and ${MAX_PAYLOAD_BYTES}.`);
  }
  return value;
}

function isScope(value: string): value is RateLimitScope {
  return (
    value === "tenant" ||
    value === "installation" ||
    value === "actor" ||
    value === "tool" ||
    value === "actor-tool" ||
    value === "installation-tool"
  );
}

function isRisk(value: unknown): value is RiskLevel {
  return value === "READ" || value === "WRITE" || value === "CRITICAL";
}

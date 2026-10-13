import type {
  InvocationContext,
  PolicyDecision,
  PolicyEvaluator,
  ToolDefinition,
} from "./contracts.js";
import { SignedApprovalVerifier } from "../security/approval.js";
import type { ApprovalReplayStore } from "../security/approval-replay.js";

export class SecureDefaultPolicyEvaluator implements PolicyEvaluator {
  async evaluate(
    tool: ToolDefinition,
    _input: unknown,
    _context: InvocationContext,
  ): Promise<PolicyDecision> {
    if (tool.risk === "READ") {
      return {
        outcome: "ALLOW",
        reason: "Read-only operations are allowed by the secure default policy.",
      };
    }

    return {
      outcome: "REQUIRE_APPROVAL",
      reason:
        tool.risk === "CRITICAL"
          ? "Critical operations require an explicit approval decision from the Kairoseth control plane."
          : "Write operations require an explicit approval decision from the Kairoseth control plane.",
    };
  }
}

export interface SignedApprovalPolicyEvaluatorOptions {
  replayStore: ApprovalReplayStore;
  now?: (() => Date) | undefined;
  replayRetentionMs?: number | undefined;
}

const DEFAULT_REPLAY_RETENTION_MS = 24 * 60 * 60 * 1_000;

export class SignedApprovalPolicyEvaluator implements PolicyEvaluator {
  private readonly now: () => Date;
  private readonly replayRetentionMs: number;

  constructor(
    private readonly verifier: SignedApprovalVerifier,
    private readonly options: SignedApprovalPolicyEvaluatorOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.replayRetentionMs =
      options.replayRetentionMs ?? DEFAULT_REPLAY_RETENTION_MS;

    if (this.replayRetentionMs <= 0) {
      throw new Error("Approval replay retention must be positive.");
    }
  }

  async evaluate(
    tool: ToolDefinition,
    input: unknown,
    context: InvocationContext,
  ): Promise<PolicyDecision> {
    if (tool.risk === "READ") {
      return {
        outcome: "ALLOW",
        reason: "Read-only operations are allowed by policy.",
      };
    }

    if (!context.tenantId || !context.installationId) {
      return {
        outcome: "DENY",
        reason: "Mutating operations require tenant and installation scope.",
      };
    }

    if (!context.approvalToken) {
      return {
        outcome: "REQUIRE_APPROVAL",
        reason: `${tool.risk} operation requires signed Kairoseth approval.`,
      };
    }

    const verification = await this.verifier.verify(context.approvalToken, {
      tenantId: context.tenantId,
      installationId: context.installationId,
      toolId: tool.id,
      correlationId: context.correlationId,
      input,
    });

    if (!verification.valid) {
      return {
        outcome: "DENY",
        reason: verification.reason,
      };
    }

    if (verification.decision === "DENY") {
      return {
        outcome: "DENY",
        reason: verification.reason,
      };
    }

    const consumedAt = this.now();
    const expiresAt = Date.parse(verification.payload.expiresAt);
    const retainUntil = new Date(
      Math.max(consumedAt.getTime(), expiresAt) + this.replayRetentionMs,
    );

    try {
      await this.options.replayStore.prune(consumedAt);

      const consumed = await this.options.replayStore.consume({
        version: "kab.approval-replay.v1",
        nonce: verification.payload.nonce,
        tenantId: verification.payload.tenantId,
        installationId: verification.payload.installationId,
        toolId: verification.payload.toolId,
        correlationId: verification.payload.correlationId,
        actionFingerprint: verification.payload.actionFingerprint,
        consumedAt: consumedAt.toISOString(),
        retainUntil: retainUntil.toISOString(),
      });

      if (!consumed) {
        return {
          outcome: "DENY",
          reason: "Signed approval nonce has already been consumed.",
        };
      }
    } catch {
      return {
        outcome: "DENY",
        reason: "Approval replay protection is unavailable.",
      };
    }

    return {
      outcome: "ALLOW",
      reason: verification.reason,
    };
  }
}

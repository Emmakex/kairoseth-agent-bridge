import type {
  InvocationContext,
  PolicyDecision,
  PolicyEvaluator,
  ToolDefinition,
} from "./contracts.js";
import { SignedApprovalVerifier } from "../security/approval.js";

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

export class SignedApprovalPolicyEvaluator implements PolicyEvaluator {
  constructor(private readonly verifier: SignedApprovalVerifier) {}

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

    return {
      outcome: "ALLOW",
      reason: verification.reason,
    };
  }
}

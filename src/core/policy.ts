import type {
  InvocationContext,
  PolicyDecision,
  PolicyEvaluator,
  ToolDefinition,
} from "./contracts.js";

export class SecureDefaultPolicyEvaluator implements PolicyEvaluator {
  async evaluate(
    tool: ToolDefinition,
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

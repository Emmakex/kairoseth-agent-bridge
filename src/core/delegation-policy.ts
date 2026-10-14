import type {
  InvocationContext,
  PolicyDecision,
  PolicyEvaluator,
  ToolDefinition,
} from "./contracts.js";
import type { SignedAgentDelegationVerifier } from "../security/agent-delegation.js";

/**
 * Protocol-neutral policy decorator for agent delegation.
 *
 * A valid delegation only establishes that the delegate is allowed to request
 * the tool/risk under the delegated scope. The wrapped policy remains fully
 * authoritative afterwards, so WRITE/CRITICAL operations can still require a
 * separate signed approval.
 */
export class DelegationPolicyEvaluator implements PolicyEvaluator {
  constructor(
    private readonly inner: PolicyEvaluator,
    private readonly verifier: SignedAgentDelegationVerifier,
  ) {}

  async evaluate(
    tool: ToolDefinition,
    input: unknown,
    context: InvocationContext,
  ): Promise<PolicyDecision> {
    const token = context.delegationToken;

    if (!token) {
      if (context.delegationRequired === true) {
        return {
          outcome: "DENY",
          reason: "This principal requires a signed agent delegation grant.",
        };
      }
      return this.inner.evaluate(tool, input, context);
    }

    if (!context.tenantId || !context.installationId) {
      return {
        outcome: "DENY",
        reason: "Agent delegation requires tenant and installation scope.",
      };
    }

    const verification = await this.verifier.verify(token, {
      tenantId: context.tenantId,
      installationId: context.installationId,
      delegateActor: context.actor,
      toolId: tool.id,
      risk: tool.risk,
    });

    if (!verification.valid) {
      return {
        outcome: "DENY",
        reason: verification.reason,
      };
    }

    return this.inner.evaluate(tool, input, context);
  }
}

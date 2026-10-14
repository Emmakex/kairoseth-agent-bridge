import type {
  AuditEvent,
  AuditSink,
  BridgeInvocationResult,
  InvocationContext,
  PolicyEvaluator,
  ToolDefinition,
} from "../core/contracts.js";
import { NoopAuditSink } from "../core/audit.js";
import { SecureDefaultPolicyEvaluator } from "../core/policy.js";
import { normalizeInvocationProvenance } from "../core/provenance.js";
import { ToolRegistry } from "../core/registry.js";

export interface BridgeRuntimeOptions {
  registry?: ToolRegistry;
  policy?: PolicyEvaluator;
  audit?: AuditSink;
}

export class BridgeRuntime {
  readonly registry: ToolRegistry;
  private readonly policy: PolicyEvaluator;
  private readonly audit: AuditSink;

  constructor(options: BridgeRuntimeOptions = {}) {
    this.registry = options.registry ?? new ToolRegistry();
    this.policy = options.policy ?? new SecureDefaultPolicyEvaluator();
    this.audit = options.audit ?? new NoopAuditSink();
  }

  async invoke(
    toolId: string,
    input: unknown,
    context: InvocationContext,
  ): Promise<BridgeInvocationResult> {
    const tool = this.registry.get(toolId);

    if (!tool) {
      return {
        status: "failed",
        correlationId: context.correlationId,
        error: `Unknown tool: ${toolId}`,
      };
    }

    await this.emit(tool, context, "INVOCATION_RECEIVED");

    const decision = await this.policy.evaluate(tool, input, context);
    await this.audit.emit({
      ...this.baseEvent(tool, context),
      type: "POLICY_EVALUATED",
      outcome: decision.outcome,
      message: decision.reason,
    });

    if (decision.outcome === "DENY") {
      return {
        status: "denied",
        correlationId: context.correlationId,
        reason: decision.reason,
      };
    }

    if (decision.outcome === "REQUIRE_APPROVAL") {
      return {
        status: "approval_required",
        correlationId: context.correlationId,
        reason: decision.reason,
      };
    }

    await this.emit(tool, context, "EXECUTION_STARTED");

    try {
      const output = await tool.execute(input, context);
      await this.emit(tool, context, "EXECUTION_SUCCEEDED");

      return {
        status: "executed",
        correlationId: context.correlationId,
        output,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown execution error";

      await this.audit.emit({
        ...this.baseEvent(tool, context),
        type: "EXECUTION_FAILED",
        message,
      });

      return {
        status: "failed",
        correlationId: context.correlationId,
        error: message,
      };
    }
  }

  private baseEvent(
    tool: ToolDefinition,
    context: InvocationContext,
  ): Omit<AuditEvent, "type"> {
    return {
      correlationId: context.correlationId,
      toolId: tool.id,
      actor: context.actor,
      risk: tool.risk,
      occurredAt: new Date().toISOString(),
      ...(context.provenance
        ? { provenance: normalizeInvocationProvenance(context.provenance) }
        : {}),
    };
  }

  private async emit(
    tool: ToolDefinition,
    context: InvocationContext,
    type: AuditEvent["type"],
  ): Promise<void> {
    await this.audit.emit({
      ...this.baseEvent(tool, context),
      type,
    });
  }
}

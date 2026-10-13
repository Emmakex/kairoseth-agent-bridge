export type RiskLevel = "READ" | "WRITE" | "CRITICAL";

export type PolicyOutcome = "ALLOW" | "DENY" | "REQUIRE_APPROVAL";

export interface InvocationContext {
  correlationId: string;
  actor: string;
  tenantId?: string;
  installationId?: string;
  approvalToken?: string;
  metadata?: Readonly<Record<string, string>>;
}

/**
 * Protocol-neutral execution hints. These are descriptive only and MUST NOT
 * replace the Bridge policy evaluator, signed approvals or authorization.
 */
export interface ToolExecutionHints {
  /** The tool can be safely re-issued with the same semantic request. */
  idempotent?: boolean;
  /** The tool may perform destructive or irreversible mutations. */
  destructive?: boolean;
  /** The tool interacts with an external/open-world system. */
  openWorld?: boolean;
}

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  id: string;
  name: string;
  description: string;
  risk: RiskLevel;
  /** Protocol-neutral JSON-schema-compatible metadata for discovery adapters. */
  inputSchema?: object;
  /** Optional protocol-neutral JSON-schema-compatible output metadata. */
  outputSchema?: object;
  /** Descriptive hints only; never an authorization source. */
  hints?: ToolExecutionHints;
  execute(input: TInput, context: InvocationContext): Promise<TOutput>;
}

export interface PolicyDecision {
  outcome: PolicyOutcome;
  reason: string;
}

export interface PolicyEvaluator {
  evaluate(
    tool: ToolDefinition,
    input: unknown,
    context: InvocationContext,
  ): Promise<PolicyDecision>;
}

export type AuditEventType =
  | "INVOCATION_RECEIVED"
  | "POLICY_EVALUATED"
  | "EXECUTION_STARTED"
  | "EXECUTION_SUCCEEDED"
  | "EXECUTION_FAILED";

export interface AuditEvent {
  type: AuditEventType;
  correlationId: string;
  toolId: string;
  actor: string;
  risk: RiskLevel;
  occurredAt: string;
  outcome?: PolicyOutcome;
  message?: string;
}

export interface AuditSink {
  emit(event: AuditEvent): Promise<void>;
}

export type BridgeInvocationResult<TOutput = unknown> =
  | {
      status: "executed";
      correlationId: string;
      output: TOutput;
    }
  | {
      status: "approval_required";
      correlationId: string;
      reason: string;
    }
  | {
      status: "denied";
      correlationId: string;
      reason: string;
    }
  | {
      status: "failed";
      correlationId: string;
      error: string;
    };

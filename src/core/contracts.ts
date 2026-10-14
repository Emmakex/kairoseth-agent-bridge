export type RiskLevel = "READ" | "WRITE" | "CRITICAL";

export type PolicyOutcome = "ALLOW" | "DENY" | "REQUIRE_APPROVAL";

export type SupportedLocale = "es" | "en";

export type InvocationProtocol =
  | "kairoseth-native"
  | "mcp"
  | "a2a"
  | "rest"
  | "webhook"
  | "internal";

export interface AuthenticatedPrincipalProvenance {
  issuer: string;
  subject: string;
  authenticationMethod: string;
  clientId?: string;
}

/**
 * Safe, protocol-neutral lineage carried with an invocation. It contains only
 * identifiers needed to reconstruct an agent-to-agent chain; credentials,
 * tokens and authorization scopes must never be stored here.
 */
export interface InvocationProvenance {
  version: "kab.provenance.v1";
  protocol: InvocationProtocol;
  rootCorrelationId: string;
  parentCorrelationId?: string;
  principal?: AuthenticatedPrincipalProvenance;
}

export interface LocalizedToolText {
  name: string;
  description: string;
}

export type ToolLocalizations = Partial<
  Readonly<Record<SupportedLocale, LocalizedToolText>>
>;

export interface InvocationContext {
  correlationId: string;
  actor: string;
  tenantId?: string;
  installationId?: string;
  approvalToken?: string;
  /**
   * Optional signed delegation grant carried separately from descriptive
   * protocol metadata. It never counts as a human approval.
   */
  delegationToken?: string;
  /**
   * Trusted host/policy hint indicating that this principal may only execute
   * when a valid delegation grant is present. Untrusted clients must never set
   * this flag directly.
   */
  delegationRequired?: boolean;
  /** Safe lineage only. Never place credentials or raw tokens in provenance. */
  provenance?: InvocationProvenance;
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
  /** Canonical fallback text; localized discovery should prefer localizations. */
  name: string;
  description: string;
  /** ES/EN user-facing discovery text. Tool IDs remain locale-independent. */
  localizations?: ToolLocalizations;
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
  provenance?: InvocationProvenance;
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

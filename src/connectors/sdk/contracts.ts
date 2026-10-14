import type {
  InvocationContext,
  RiskLevel,
  SupportedLocale,
  ToolLocalizations,
} from "../../core/contracts.js";
import type { ConnectorCircuitSnapshot } from "./circuit-breaker.js";

export type JsonSchemaPrimitiveType =
  | "null"
  | "boolean"
  | "object"
  | "array"
  | "number"
  | "integer"
  | "string";

export type JsonSchemaValue = string | number | boolean | null;

/**
 * Deliberately small JSON-Schema-compatible contract for connector manifests.
 * It can be extended without coupling the runtime to one validator package.
 */
export interface JsonSchema {
  type?: JsonSchemaPrimitiveType | readonly JsonSchemaPrimitiveType[] | undefined;
  title?: string | undefined;
  description?: string | undefined;
  format?: string | undefined;
  enum?: readonly JsonSchemaValue[] | undefined;
  const?: JsonSchemaValue | undefined;
  properties?: Readonly<Record<string, JsonSchema>> | undefined;
  required?: readonly string[] | undefined;
  additionalProperties?: boolean | JsonSchema | undefined;
  items?: JsonSchema | readonly JsonSchema[] | undefined;
  oneOf?: readonly JsonSchema[] | undefined;
  anyOf?: readonly JsonSchema[] | undefined;
  allOf?: readonly JsonSchema[] | undefined;
  minimum?: number | undefined;
  maximum?: number | undefined;
  minLength?: number | undefined;
  maxLength?: number | undefined;
  pattern?: string | undefined;
  default?: JsonSchemaValue | undefined;
}

export type ConnectorCredentialKind =
  | "api_key"
  | "bearer"
  | "basic"
  | "oauth2"
  | "database"
  | "certificate"
  | "custom";

export interface ConnectorLocalizedLabelText {
  label: string;
  description?: string | undefined;
}

export type ConnectorLabelLocalizations = Partial<
  Readonly<Record<SupportedLocale, ConnectorLocalizedLabelText>>
>;

export interface ConnectorCredentialField {
  id: string;
  label: string;
  secret: boolean;
  required: boolean;
  description?: string | undefined;
  /** Optional ES/EN setup labels/descriptions. */
  localizations?: ConnectorLabelLocalizations | undefined;
}

export interface ConnectorCredentialRequirement {
  id: string;
  kind: ConnectorCredentialKind;
  label: string;
  required: boolean;
  description?: string | undefined;
  /** Optional ES/EN setup labels/descriptions. */
  localizations?: ConnectorLabelLocalizations | undefined;
  fields: readonly ConnectorCredentialField[];
}

/**
 * Metadata-only notice that a credential was rotated outside the connector.
 * Secret values must never be embedded in this object.
 */
export interface ConnectorCredentialRotationNotice {
  rotationId: string;
  requirementId: string;
  fieldIds: readonly string[];
  rotatedAt: string;
  /** Opaque non-secret backend revision/version for correlation only. */
  revision?: string | undefined;
}

export interface ConnectorSecretRefreshContext {
  connectorId: string;
  connectorInstanceId: string;
  signal: AbortSignal;
}

export interface ConnectorSecretProvider {
  getSecret(requirementId: string, fieldId: string): Promise<string | null>;
  /**
   * Optional cache/handle invalidation hook. Providers without this hook must
   * resolve the current credential on every getSecret() call.
   */
  refreshCredentials?(
    notice: ConnectorCredentialRotationNotice,
    context: ConnectorSecretRefreshContext,
  ): Promise<void>;
}

export type ConnectorCredentialRotationRuntimeStatus =
  | "idle"
  | "refreshing"
  | "blocked";

export type ConnectorCredentialRotationFailureReason =
  | "refresh_failed"
  | "timeout";

export interface ConnectorCredentialRotationState {
  status: ConnectorCredentialRotationRuntimeStatus;
  rotationId?: string | undefined;
  requirementId?: string | undefined;
  fieldIds?: readonly string[] | undefined;
  rotatedAt?: string | undefined;
  revision?: string | undefined;
  failureReason?: ConnectorCredentialRotationFailureReason | undefined;
}

export interface ConnectorCredentialRotationContext {
  connectorId: string;
  connectorInstanceId: string;
  config: Readonly<Record<string, unknown>>;
  secrets: ConnectorSecretProvider;
  signal: AbortSignal;
}

export interface ConnectorCredentialRotationResult {
  status: "applied";
  rotationId: string;
  connectorId: string;
  connectorInstanceId: string;
  requirementId: string;
  fieldIds: readonly string[];
  rotatedAt: string;
  revision?: string | undefined;
  providerRefresh: "live" | "refreshed";
  connectorHook: "not_declared" | "applied";
  appliedAt: string;
}

export type ConnectorIdempotencyMode = "none" | "intrinsic" | "keyed";

export interface ConnectorIdempotencyPolicy {
  mode: ConnectorIdempotencyMode;
  /** Required when mode is keyed; points to a field/path in the tool input contract. */
  keyField?: string | undefined;
}

export interface ConnectorRetryPolicy {
  mode: "never" | "transient";
  maxAttempts?: number | undefined;
  baseDelayMs?: number | undefined;
  maxDelayMs?: number | undefined;
}

export interface ConnectorToolBehavior {
  timeoutMs?: number | undefined;
  retry?: ConnectorRetryPolicy | undefined;
  idempotency?: ConnectorIdempotencyPolicy | undefined;
}

export interface ConnectorToolExecutionContext {
  invocation: InvocationContext;
  connectorId: string;
  connectorInstanceId: string;
  config: Readonly<Record<string, unknown>>;
  secrets: ConnectorSecretProvider;
  signal: AbortSignal;
  /** 1-based execution attempt. Automatic retries increment this value. */
  attempt: number;
  /** Derived for keyed idempotency and reusable by remote API adapters. */
  idempotencyKey?: string | undefined;
}

export interface ConnectorToolDefinition<TInput = unknown, TOutput = unknown> {
  id: string;
  name: string;
  description: string;
  /** Optional ES/EN titles/descriptions exposed by discovery protocols. */
  localizations?: ToolLocalizations | undefined;
  risk: RiskLevel;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema | undefined;
  behavior?: ConnectorToolBehavior | undefined;
  execute(
    input: TInput,
    context: ConnectorToolExecutionContext,
  ): Promise<TOutput>;
}

export interface ConnectorManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  /** Optional ES/EN connector name/description for setup and discovery UIs. */
  localizations?: ToolLocalizations | undefined;
  capabilities: readonly string[];
  /** Non-secret connector instance configuration only. */
  configSchema?: JsonSchema | undefined;
  /** Credential metadata only; never credential values. */
  credentials: readonly ConnectorCredentialRequirement[];
}

export type ConnectorHealthStatus = "healthy" | "degraded" | "unhealthy";

export interface ConnectorHealthResult {
  status: ConnectorHealthStatus;
  checkedAt: string;
  message?: string | undefined;
  details?: Readonly<Record<string, string | number | boolean | null>> | undefined;
}

export interface ConnectorHealthContext {
  connectorId: string;
  connectorInstanceId: string;
  config: Readonly<Record<string, unknown>>;
  secrets: ConnectorSecretProvider;
  signal: AbortSignal;
}

export type ConnectorToolAvailabilityStatus =
  | "available"
  | "degraded"
  | "blocked";

export type ConnectorToolBlockedReason =
  | "circuit_open"
  | "credential_rotation";

export interface ConnectorToolHealthSnapshot {
  /** Connector-local tool ID. */
  toolId: string;
  /** Fully namespaced ToolRegistry ID. */
  runtimeToolId: string;
  availability: ConnectorToolAvailabilityStatus;
  blockedReason?: ConnectorToolBlockedReason | undefined;
  /** Omitted only when circuit breakers are explicitly disabled by deployment. */
  circuit?: ConnectorCircuitSnapshot | undefined;
}

/**
 * Operational, read-only health view for one connector instance.
 * It combines the connector probe with per-tool availability isolation.
 */
export interface ConnectorInstanceHealthSnapshot {
  connectorId: string;
  connectorInstanceId: string;
  status: ConnectorHealthStatus;
  checkedAt: string;
  probe: ConnectorHealthResult;
  tools: readonly ConnectorToolHealthSnapshot[];
  /** Present only while a rotation is refreshing or fail-closed blocked. */
  credentialRotation?: ConnectorCredentialRotationState | undefined;
}

export interface ConnectorDefinition {
  manifest: ConnectorManifest;
  tools: readonly ConnectorToolDefinition[];
  health?(context: ConnectorHealthContext): Promise<ConnectorHealthResult>;
  /**
   * Optional hook used to rebuild connector-owned clients/pools after the
   * SecretProvider has refreshed its current credential view.
   */
  credentialsRotated?(
    notice: ConnectorCredentialRotationNotice,
    context: ConnectorCredentialRotationContext,
  ): Promise<void>;
}

export interface ConnectorInstance {
  instanceId: string;
  connector: ConnectorDefinition;
  config?: Readonly<Record<string, unknown>> | undefined;
  secrets: ConnectorSecretProvider;
}

export interface RegisteredConnectorInstance {
  connectorId: string;
  instanceId: string;
  toolIds: readonly string[];
}

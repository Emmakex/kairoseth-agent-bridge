import type {
  InvocationContext,
  RiskLevel,
  ToolLocalizations,
} from "../../core/contracts.js";

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

export interface ConnectorCredentialField {
  id: string;
  label: string;
  secret: boolean;
  required: boolean;
  description?: string | undefined;
}

export interface ConnectorCredentialRequirement {
  id: string;
  kind: ConnectorCredentialKind;
  label: string;
  required: boolean;
  description?: string | undefined;
  fields: readonly ConnectorCredentialField[];
}

export interface ConnectorSecretProvider {
  getSecret(requirementId: string, fieldId: string): Promise<string | null>;
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

export interface ConnectorDefinition {
  manifest: ConnectorManifest;
  tools: readonly ConnectorToolDefinition[];
  health?(context: ConnectorHealthContext): Promise<ConnectorHealthResult>;
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

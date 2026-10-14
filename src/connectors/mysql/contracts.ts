import type { RiskLevel, ToolLocalizations } from "../../core/contracts.js";
import type {
  ConnectorIdempotencyPolicy,
  JsonSchema,
} from "../sdk/contracts.js";

export type MySqlParameterType =
  | "string"
  | "integer"
  | "number"
  | "boolean"
  | "date"
  | "date-time";

export interface MySqlProfileParameter {
  id: string;
  type: MySqlParameterType;
  required?: boolean | undefined;
  description?: string | undefined;
  minimum?: number | undefined;
  maximum?: number | undefined;
  maxLength?: number | undefined;
}

export interface MySqlProfile {
  id: string;
  name: string;
  description: string;
  /** Official and customer-managed profiles must publish both ES and EN metadata. */
  localizations: ToolLocalizations;
  risk: RiskLevel;
  /** Fixed statement. Agents can only provide values for declared placeholders. */
  statement: string;
  /** Positional parameters in the exact order of ? placeholders. */
  parameters: readonly MySqlProfileParameter[];
  /** READ result bound after execution. Defaults to 500, hard-capped at 5000. */
  maxRows?: number | undefined;
  /** Extra result-column names to redact recursively. */
  redactColumns?: readonly string[] | undefined;
  /** Mutation idempotency must be explicitly declared when it is not none. */
  idempotency?: ConnectorIdempotencyPolicy | undefined;
  timeoutMs?: number | undefined;
}

export interface MySqlConnectorOptions {
  profiles: readonly MySqlProfile[];
  /** Exact host allowlist controlled by deployment code, not by agents. */
  allowedHosts?: readonly string[] | undefined;
  /** TLS verification is the default. Plain TCP requires this explicit deployment opt-in. */
  allowTlsDisabled?: boolean | undefined;
}

export interface MySqlConnectionSettings {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  tlsMode: "verify" | "disabled";
  tlsCa?: string | undefined;
  connectTimeoutMs: number;
}

export interface MySqlExecutionRequest {
  statement: string;
  values: readonly MySqlBindableValue[];
  mode: "read" | "mutation";
  signal: AbortSignal;
}

export type MySqlBindableValue = string | number | boolean | null;

export interface MySqlReadResult {
  kind: "rows";
  rows: readonly Readonly<Record<string, unknown>>[];
}

export interface MySqlMutationResult {
  kind: "mutation";
  affectedRows: number;
  changedRows: number;
  insertId?: number | undefined;
  warningStatus?: number | undefined;
}

export type MySqlExecutionResult = MySqlReadResult | MySqlMutationResult;

export interface MySqlRuntime {
  execute(
    settings: MySqlConnectionSettings,
    request: MySqlExecutionRequest,
  ): Promise<MySqlExecutionResult>;
  health(settings: MySqlConnectionSettings, signal: AbortSignal): Promise<void>;
}

export interface ValidatedMySqlProfile {
  profile: MySqlProfile;
  statement: string;
  inputSchema: JsonSchema;
  maxRows: number;
  redactColumns: ReadonlySet<string>;
}

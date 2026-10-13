import type {
  ConnectorToolBehavior,
  JsonSchema,
} from "../sdk/contracts.js";
import type { RiskLevel } from "../../core/contracts.js";

export type GenericRestMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";

export type GenericRestAuth =
  | { type: "none" }
  | {
      type: "bearer";
      requirementId?: string | undefined;
      tokenField?: string | undefined;
    }
  | {
      type: "basic";
      requirementId?: string | undefined;
      usernameField?: string | undefined;
      passwordField?: string | undefined;
    }
  | {
      type: "api_key_header";
      requirementId?: string | undefined;
      valueField?: string | undefined;
      headerName: string;
      prefix?: string | undefined;
    };

export interface GenericRestBodyMapping {
  source: "input" | "field";
  field?: string | undefined;
}

export interface GenericRestOperation {
  id: string;
  name: string;
  description: string;
  risk: RiskLevel;
  method: GenericRestMethod;
  /** Relative path beginning with /; placeholders use {topLevelInputField}. */
  pathTemplate: string;
  /** Query parameter name -> top-level input field. */
  query?: Readonly<Record<string, string>> | undefined;
  /** Static non-secret headers only. Authentication headers are generated separately. */
  headers?: Readonly<Record<string, string>> | undefined;
  body?: GenericRestBodyMapping | undefined;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema | undefined;
  behavior?: ConnectorToolBehavior | undefined;
}

export interface GenericRestNetworkPolicy {
  /** HTTPS is required by default. Enable only for a controlled local/on-prem network. */
  allowHttp?: boolean | undefined;
  /** Public addresses only by default. Enable for a controlled local/on-prem runtime. */
  allowPrivateNetwork?: boolean | undefined;
  /** Optional exact origin allowlist, e.g. https://api.example.com:8443. */
  allowedOrigins?: readonly string[] | undefined;
}

export interface GenericRestResponsePolicy {
  maxBytes?: number | undefined;
  /** JSON object keys redacted recursively, in addition to built-in sensitive names. */
  redactKeys?: readonly string[] | undefined;
}

export interface GenericRestConnectorOptions {
  name?: string | undefined;
  version?: string | undefined;
  description?: string | undefined;
  auth?: GenericRestAuth | undefined;
  operations: readonly GenericRestOperation[];
  network?: GenericRestNetworkPolicy | undefined;
  response?: GenericRestResponsePolicy | undefined;
  healthPath?: string | undefined;
}

export interface GenericRestResult {
  status: number;
  ok: boolean;
  body: unknown;
}

export interface GenericRestHttpRuntime {
  fetch(input: string, init: RequestInit): Promise<Response>;
  resolveHost(hostname: string): Promise<readonly string[]>;
}

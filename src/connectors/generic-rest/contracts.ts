import type {
  ConnectorToolBehavior,
  JsonSchema,
} from "../sdk/contracts.js";
import type { RiskLevel } from "../../core/contracts.js";

export type GenericRestMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "HEAD";

export type GenericRestAuth =
  | { type: "none" }
  | {
      type: "bearer";
      requirementId: string;
      tokenField: string;
    }
  | {
      type: "api_key";
      requirementId: string;
      fieldId: string;
      location: "header" | "query";
      name: string;
    }
  | {
      type: "basic";
      requirementId: string;
      usernameField: string;
      passwordField: string;
    };

export interface GenericRestRequestMapping {
  /** Static relative path template, e.g. /v1/orders/{orderId}. */
  path: string;
  /** Query parameter name -> input field path. Null/undefined values are omitted. */
  query?: Readonly<Record<string, string>> | undefined;
  /** Optional JSON body source. "$" means the whole tool input. */
  bodyInputPath?: string | undefined;
  /** Non-secret static headers. Sensitive/auth headers are forbidden here. */
  headers?: Readonly<Record<string, string>> | undefined;
}

export interface GenericRestResponsePolicy {
  /** Maximum decoded response body bytes. Defaults to 1 MiB. */
  maxBytes?: number | undefined;
  /** Response mode. JSON is the secure/default interoperability mode. */
  mode?: "json" | "text" | undefined;
  /** Additional JSON object key names to redact recursively. */
  redactKeys?: readonly string[] | undefined;
}

export interface GenericRestEndpointDefinition {
  id: string;
  name: string;
  description: string;
  risk: RiskLevel;
  method: GenericRestMethod;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema | undefined;
  request: GenericRestRequestMapping;
  response?: GenericRestResponsePolicy | undefined;
  behavior?: ConnectorToolBehavior | undefined;
  /** Optional endpoint-level auth override. */
  auth?: GenericRestAuth | undefined;
}

export interface GenericRestConnectorOptions {
  id?: string | undefined;
  name?: string | undefined;
  version?: string | undefined;
  description?: string | undefined;
  auth?: GenericRestAuth | undefined;
  endpoints: readonly GenericRestEndpointDefinition[];
  /** Non-secret headers applied to all endpoints. */
  defaultHeaders?: Readonly<Record<string, string>> | undefined;
  /** HTTP is disabled by default. Intended only for explicitly trusted local/dev targets. */
  allowHttp?: boolean | undefined;
  /** Injectable fetch implementation for tests/controlled runtimes. */
  fetch?: typeof globalThis.fetch | undefined;
}

export interface GenericRestInstanceConfig {
  /** Fixed by connector instance configuration, never supplied by an agent tool input. */
  baseUrl: string;
}

export interface GenericRestToolOutput {
  status: number;
  body: unknown;
}

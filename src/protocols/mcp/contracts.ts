import type { InvocationContext } from "../../core/contracts.js";

export type McpCacheScope = "public" | "private";

export interface McpToolAnnotations {
  title?: string | undefined;
  readOnlyHint?: boolean | undefined;
  destructiveHint?: boolean | undefined;
  idempotentHint?: boolean | undefined;
  openWorldHint?: boolean | undefined;
}

export interface McpToolDescriptor {
  name: string;
  title?: string | undefined;
  description?: string | undefined;
  inputSchema: Readonly<Record<string, unknown>>;
  outputSchema?: Readonly<Record<string, unknown>> | undefined;
  annotations?: McpToolAnnotations | undefined;
}

export interface McpListToolsResult {
  tools: readonly McpToolDescriptor[];
  /** MCP 2026-07-28 cache hint. Zero is immediately stale. */
  ttlMs: number;
  /** Tool visibility is authorization-context-specific by default. */
  cacheScope: McpCacheScope;
}

export interface McpCallToolParams {
  name: string;
  arguments?: Readonly<Record<string, unknown>> | undefined;
}

export interface McpTextContent {
  type: "text";
  text: string;
}

export interface McpCallToolResult {
  content: readonly McpTextContent[];
  /** MCP 2026-07-28 allows structured tool output to be any JSON value. */
  structuredContent?: unknown;
  isError?: boolean | undefined;
}

/**
 * Authenticated hosting/transport code supplies this context. MCP clientInfo,
 * tool annotations and other self-reported protocol metadata are never trusted
 * as Kairoseth authorization inputs.
 */
export type McpInvocationContext = InvocationContext;

export type McpToolCallErrorCode =
  | "KAIROSETH_APPROVAL_REQUIRED"
  | "KAIROSETH_DENIED"
  | "KAIROSETH_EXECUTION_FAILED";

export interface McpToolCallErrorBody {
  code: McpToolCallErrorCode;
  correlationId: string;
}

export class McpAdapterError extends Error {
  readonly name = "McpAdapterError";

  constructor(
    readonly code: "INVALID_TOOL_NAME" | "UNKNOWN_TOOL" | "INVALID_ARGUMENTS",
    message: string,
  ) {
    super(message);
  }
}

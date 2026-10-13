import type {
  SupportedLocale,
  ToolDefinition,
} from "../../core/contracts.js";
import type { BridgeRuntime } from "../../runtime/bridge-runtime.js";
import {
  McpAdapterError,
  type McpCallToolParams,
  type McpCallToolResult,
  type McpInvocationContext,
  type McpListToolsResult,
  type McpToolAnnotations,
  type McpToolCallErrorBody,
  type McpToolDescriptor,
} from "./contracts.js";

const MCP_TOOL_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;
const MCP_TOOL_NAME_MAX_LENGTH = 128;
const FALLBACK_INPUT_SCHEMA: Readonly<Record<string, unknown>> = {
  type: "object",
  additionalProperties: true,
};

const MESSAGES: Readonly<Record<SupportedLocale, Readonly<Record<string, string>>>> = {
  en: {
    completed: "Tool completed successfully.",
    approvalRequired: "Approval required by Kairoseth policy.",
    denied: "Tool invocation denied by Kairoseth policy.",
    executionFailed: "Tool execution failed in Kairoseth Agent Bridge.",
    nonJson: "Tool completed with a non-JSON result.",
  },
  es: {
    completed: "La herramienta se ejecutó correctamente.",
    approvalRequired: "La política de Kairoseth requiere aprobación.",
    denied: "La política de Kairoseth ha denegado la ejecución de la herramienta.",
    executionFailed: "La ejecución de la herramienta ha fallado en Kairoseth Agent Bridge.",
    nonJson: "La herramienta finalizó con un resultado no JSON.",
  },
};

export interface McpToolAdapterOptions {
  listTtlMs?: number | undefined;
  defaultLocale?: SupportedLocale | undefined;
}

/**
 * Protocol adapter only. All tool execution is delegated to BridgeRuntime so
 * MCP can never bypass Kairoseth policy, signed approvals or audit lifecycle.
 */
export class McpToolAdapter {
  private readonly listTtlMs: number;
  private readonly defaultLocale: SupportedLocale;

  constructor(
    private readonly runtime: BridgeRuntime,
    options: McpToolAdapterOptions = {},
  ) {
    this.listTtlMs = options.listTtlMs ?? 0;
    this.defaultLocale = options.defaultLocale ?? "en";
    if (!Number.isInteger(this.listTtlMs) || this.listTtlMs < 0) {
      throw new Error("MCP tools/list ttlMs must be a non-negative integer.");
    }
  }

  listTools(locale: SupportedLocale = this.defaultLocale): McpListToolsResult {
    const tools = this.runtime.registry
      .list()
      .map((tool) => this.describeTool(tool, locale))
      .sort((left, right) => compareToolNames(left.name, right.name));

    return {
      tools,
      ttlMs: this.listTtlMs,
      cacheScope: "private",
    };
  }

  getTool(
    name: string,
    locale: SupportedLocale = this.defaultLocale,
  ): McpToolDescriptor | null {
    validateMcpToolName(name);
    const tool = this.runtime.registry.get(name);
    return tool ? this.describeTool(tool, locale) : null;
  }

  async callTool(
    params: McpCallToolParams,
    invocation: McpInvocationContext,
    locale: SupportedLocale = localeFromInvocation(invocation, this.defaultLocale),
  ): Promise<McpCallToolResult> {
    validateMcpToolName(params.name);

    if (!this.runtime.registry.get(params.name)) {
      throw new McpAdapterError(
        "UNKNOWN_TOOL",
        `Unknown MCP tool: ${params.name}`,
      );
    }

    const args = params.arguments ?? {};
    if (args === null || Array.isArray(args) || typeof args !== "object") {
      throw new McpAdapterError(
        "INVALID_ARGUMENTS",
        "MCP tool arguments must be an object.",
      );
    }

    const result = await this.runtime.invoke(params.name, args, invocation);
    const messages = MESSAGES[locale];

    switch (result.status) {
      case "executed":
        return successfulToolResult(result.output, locale);
      case "approval_required":
        return bridgeErrorResult(
          "KAIROSETH_APPROVAL_REQUIRED",
          result.correlationId,
          messages.approvalRequired,
        );
      case "denied":
        return bridgeErrorResult(
          "KAIROSETH_DENIED",
          result.correlationId,
          messages.denied,
        );
      case "failed":
        return bridgeErrorResult(
          "KAIROSETH_EXECUTION_FAILED",
          result.correlationId,
          messages.executionFailed,
        );
    }
  }

  private describeTool(
    tool: ToolDefinition,
    locale: SupportedLocale,
  ): McpToolDescriptor {
    validateMcpToolName(tool.id);
    const inputSchema = tool.inputSchema
      ? normalizeInputSchema(tool.inputSchema, `${tool.id} inputSchema`)
      : structuredClone(FALLBACK_INPUT_SCHEMA);
    const outputSchema = tool.outputSchema
      ? normalizeSchema(tool.outputSchema, `${tool.id} outputSchema`)
      : undefined;
    const text = tool.localizations?.[locale] ?? {
      name: tool.name,
      description: tool.description,
    };
    const annotations = annotationsForTool(tool, text.name);

    return {
      name: tool.id,
      title: text.name,
      description: text.description,
      inputSchema,
      ...(outputSchema ? { outputSchema } : {}),
      annotations,
    };
  }
}

export function resolveSupportedLocale(
  value: string | null | undefined,
  fallback: SupportedLocale = "en",
): SupportedLocale {
  if (!value) return fallback;
  const candidates = value
    .split(",")
    .map((item) => item.trim().split(";", 1)[0]?.toLowerCase())
    .filter((item): item is string => Boolean(item));

  for (const candidate of candidates) {
    if (candidate === "es" || candidate.startsWith("es-")) return "es";
    if (candidate === "en" || candidate.startsWith("en-")) return "en";
  }
  return fallback;
}

export function validateMcpToolName(name: string): void {
  if (
    name.length < 1 ||
    name.length > MCP_TOOL_NAME_MAX_LENGTH ||
    !MCP_TOOL_NAME_PATTERN.test(name)
  ) {
    throw new McpAdapterError(
      "INVALID_TOOL_NAME",
      `MCP tool name must be 1-${MCP_TOOL_NAME_MAX_LENGTH} characters using letters, digits, underscore, dash or dot.`,
    );
  }
}

function localeFromInvocation(
  invocation: McpInvocationContext,
  fallback: SupportedLocale,
): SupportedLocale {
  return resolveSupportedLocale(invocation.metadata?.locale, fallback);
}

function annotationsForTool(
  tool: ToolDefinition,
  title: string,
): McpToolAnnotations {
  const readOnly = tool.risk === "READ";
  const destructive =
    tool.risk === "READ"
      ? false
      : tool.risk === "CRITICAL"
        ? true
        : (tool.hints?.destructive ?? true);

  return {
    title,
    readOnlyHint: readOnly,
    destructiveHint: destructive,
    ...(tool.hints?.idempotent !== undefined
      ? { idempotentHint: tool.hints.idempotent }
      : {}),
    ...(tool.hints?.openWorld !== undefined
      ? { openWorldHint: tool.hints.openWorld }
      : {}),
  };
}

function normalizeInputSchema(
  schema: object,
  label: string,
): Readonly<Record<string, unknown>> {
  const normalized = normalizeSchema(schema, label);
  if (normalized.type !== "object") {
    throw new McpAdapterError(
      "INVALID_ARGUMENTS",
      `${label} root type must be object because MCP tool arguments are an object.`,
    );
  }
  return normalized;
}

function normalizeSchema(
  schema: object,
  label: string,
): Readonly<Record<string, unknown>> {
  if (Array.isArray(schema)) {
    throw new McpAdapterError(
      "INVALID_ARGUMENTS",
      `${label} must be a JSON Schema object.`,
    );
  }

  try {
    const serialized = JSON.stringify(schema);
    if (!serialized) throw new Error("schema is not JSON serializable");
    const parsed = JSON.parse(serialized) as unknown;
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new Error("schema root is not an object");
    }
    return parsed as Readonly<Record<string, unknown>>;
  } catch (error) {
    throw new McpAdapterError(
      "INVALID_ARGUMENTS",
      `${label} is not JSON serializable: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
}

function successfulToolResult(
  output: unknown,
  locale: SupportedLocale,
): McpCallToolResult {
  if (output === undefined) {
    return {
      content: [{ type: "text", text: MESSAGES[locale].completed }],
    };
  }

  const normalized = normalizeJsonValue(output);
  if (normalized.ok) {
    return {
      content: [{ type: "text", text: renderJsonValue(normalized.value) }],
      structuredContent: normalized.value,
    };
  }

  return {
    content: [{ type: "text", text: safeString(output, locale) }],
  };
}

function bridgeErrorResult(
  code: McpToolCallErrorBody["code"],
  correlationId: string,
  message: string,
): McpCallToolResult {
  const body: McpToolCallErrorBody = { code, correlationId };
  return {
    content: [{ type: "text", text: message }],
    structuredContent: body,
    isError: true,
  };
}

function normalizeJsonValue(
  value: unknown,
): { ok: true; value: unknown } | { ok: false } {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return { ok: false };
    return { ok: true, value: JSON.parse(serialized) as unknown };
  } catch {
    return { ok: false };
  }
}

function renderJsonValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function safeString(value: unknown, locale: SupportedLocale): string {
  try {
    return String(value);
  } catch {
    return MESSAGES[locale].nonJson;
  }
}

function compareToolNames(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

import {
  ProtocolError,
  ProtocolErrorCode,
  Server,
  createMcpHandler,
  type AuthInfo,
  type CallToolResult,
  type ListToolsResult,
  type McpHttpHandler,
  type Tool,
} from "@modelcontextprotocol/server";
import {
  serveStdio,
  type StdioServerHandle,
} from "@modelcontextprotocol/server/stdio";

import type { InvocationContext } from "../../core/contracts.js";
import { McpToolAdapter } from "./adapter.js";
import {
  McpAdapterError,
  type McpToolDescriptor,
} from "./contracts.js";

export type McpTransportKind = "http" | "stdio";
export type McpProtocolEra = "modern" | "legacy";

export interface KairosethMcpRequestContext {
  transport: McpTransportKind;
  era: McpProtocolEra;
  /** Verified auth information supplied by the hosting layer. Never parsed here. */
  authInfo?: AuthInfo | undefined;
  /** Original web-standard HTTP request when the transport is HTTP. */
  request?: Request | undefined;
  /** MCP request ID for correlation/debug metadata only. */
  mcpRequestId?: string | number | undefined;
}

/**
 * Maps an already-authenticated transport request into Kairoseth's trusted
 * invocation identity/scope. Implementations must fail closed on missing or
 * invalid identity; MCP clientInfo and arbitrary request metadata are excluded.
 */
export type KairosethMcpInvocationResolver = (
  context: KairosethMcpRequestContext,
) => InvocationContext | Promise<InvocationContext>;

export interface KairosethMcpServerInfo {
  name?: string | undefined;
  title?: string | undefined;
  version?: string | undefined;
  description?: string | undefined;
}

export interface KairosethMcpServerOptions {
  adapter: McpToolAdapter;
  resolveInvocation: KairosethMcpInvocationResolver;
  serverInfo?: KairosethMcpServerInfo | undefined;
}

export interface KairosethMcpHttpOptions extends KairosethMcpServerOptions {
  /** Modern-only by default. Enable stateless legacy compatibility explicitly. */
  legacy?: "reject" | "stateless" | undefined;
  /** Defaults to 1 MiB; must remain positive. */
  maxRequestBodySize?: number | undefined;
  onerror?: ((error: Error) => void) | undefined;
}

const DEFAULT_SERVER_INFO = {
  name: "kairoseth-agent-bridge",
  title: "Kairoseth Agent Bridge",
  version: "0.1.0",
  description: "Policy-gated Kairoseth business-system tools over MCP.",
} as const;

const DEFAULT_MCP_BODY_LIMIT = 1024 * 1024;

export function createKairosethMcpSdkServer(
  options: KairosethMcpServerOptions,
  era: McpProtocolEra,
): Server {
  const info = {
    name: options.serverInfo?.name ?? DEFAULT_SERVER_INFO.name,
    title: options.serverInfo?.title ?? DEFAULT_SERVER_INFO.title,
    version: options.serverInfo?.version ?? DEFAULT_SERVER_INFO.version,
    description:
      options.serverInfo?.description ?? DEFAULT_SERVER_INFO.description,
  };

  const server = new Server(info, {
    capabilities: { tools: {} },
  });

  server.setRequestHandler(
    "tools/list",
    async (): Promise<ListToolsResult> => ({
      tools: options.adapter.listTools().tools.map(toSdkTool),
    }),
  );

  server.setRequestHandler(
    "tools/call",
    async (request, context): Promise<CallToolResult> => {
      const invocation = await options.resolveInvocation({
        transport: context.http?.req ? "http" : "stdio",
        era,
        ...(context.http?.authInfo
          ? { authInfo: context.http.authInfo }
          : {}),
        ...(context.http?.req ? { request: context.http.req } : {}),
        ...(context.mcpReq.id !== undefined
          ? { mcpRequestId: context.mcpReq.id }
          : {}),
      });

      try {
        const result = await options.adapter.callTool(
          {
            name: request.params.name,
            ...(request.params.arguments
              ? {
                  arguments: request.params.arguments as Readonly<
                    Record<string, unknown>
                  >,
                }
              : {}),
          },
          invocation,
        );

        return result as unknown as CallToolResult;
      } catch (error) {
        if (error instanceof McpAdapterError) {
          throw new ProtocolError(
            ProtocolErrorCode.InvalidParams,
            error.message,
          );
        }
        throw error;
      }
    },
  );

  return server;
}

export function createKairosethMcpHttpHandler(
  options: KairosethMcpHttpOptions,
): McpHttpHandler {
  const maxRequestBodySize =
    options.maxRequestBodySize ?? DEFAULT_MCP_BODY_LIMIT;
  if (!Number.isInteger(maxRequestBodySize) || maxRequestBodySize < 1) {
    throw new Error("MCP maxRequestBodySize must be a positive integer.");
  }

  return createMcpHandler(
    (context) => createKairosethMcpSdkServer(options, context.era),
    {
      legacy: options.legacy ?? "reject",
      responseMode: "json",
      maxRequestBodySize,
      ...(options.onerror ? { onerror: options.onerror } : {}),
    },
  );
}

export function serveKairosethMcpStdio(
  options: KairosethMcpServerOptions,
): StdioServerHandle {
  return serveStdio((context) =>
    createKairosethMcpSdkServer(options, context.era),
  );
}

function toSdkTool(tool: McpToolDescriptor): Tool {
  return {
    name: tool.name,
    ...(tool.title ? { title: tool.title } : {}),
    ...(tool.description ? { description: tool.description } : {}),
    inputSchema: tool.inputSchema as Tool["inputSchema"],
    ...(tool.outputSchema
      ? { outputSchema: tool.outputSchema as Tool["outputSchema"] }
      : {}),
    ...(tool.annotations
      ? { annotations: tool.annotations as Tool["annotations"] }
      : {}),
  };
}

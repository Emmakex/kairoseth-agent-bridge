import type {
  CommandBatch,
  OutboundCommandTransport,
} from "./command-delivery.js";
import type { CommandAcknowledgement } from "./command.js";

export interface HttpCommandTransportOptions {
  baseUrl: string;
  fetch?: typeof globalThis.fetch | undefined;
  pullPath?: string | undefined;
  acknowledgePath?: string | undefined;
  allowInsecureHttp?: boolean | undefined;
}

export class CommandTransportError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly code: string,
  ) {
    super(message);
    this.name = "CommandTransportError";
  }
}

const DEFAULT_PULL_PATH = "/api/products/agent-bridge/commands/pull";
const DEFAULT_ACKNOWLEDGE_PATH = "/api/products/agent-bridge/commands/ack";

export class HttpCommandTransport implements OutboundCommandTransport {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly pullUrl: URL;
  private readonly acknowledgeUrl: URL;

  constructor(options: HttpCommandTransportOptions) {
    const baseUrl = normalizedBaseUrl(
      options.baseUrl,
      options.allowInsecureHttp ?? false,
    );
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.pullUrl = endpoint(baseUrl, options.pullPath ?? DEFAULT_PULL_PATH);
    this.acknowledgeUrl = endpoint(
      baseUrl,
      options.acknowledgePath ?? DEFAULT_ACKNOWLEDGE_PATH,
    );
  }

  async fetchCommands(
    accessToken: string,
    sessionId: string,
    limit: number,
  ): Promise<CommandBatch> {
    const token = requireCredential(accessToken, "session access token");
    const session = requireCredential(sessionId, "session ID");

    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("Command pull limit must be between 1 and 100.");
    }

    const response = await this.fetchImpl(this.pullUrl, {
      method: "POST",
      headers: bearerJsonHeaders(token),
      body: JSON.stringify({ sessionId: session, limit }),
      redirect: "error",
      cache: "no-store",
    });
    const payload = await safeJson(response);

    if (!response.ok) {
      throw new CommandTransportError(
        "Kairoseth Platform rejected the command pull request.",
        response.status,
        responseCode(payload),
      );
    }

    const batch =
      payload && typeof payload === "object" && "batch" in payload
        ? (payload as { batch?: unknown }).batch
        : null;

    if (!isCommandBatch(batch, limit)) {
      throw new CommandTransportError(
        "Kairoseth Platform returned an invalid command batch.",
        response.status,
        "invalid_command_batch_response",
      );
    }

    return batch;
  }

  async acknowledgeCommand(
    accessToken: string,
    acknowledgement: CommandAcknowledgement,
  ): Promise<void> {
    const token = requireCredential(accessToken, "session access token");

    const response = await this.fetchImpl(this.acknowledgeUrl, {
      method: "POST",
      headers: bearerJsonHeaders(token),
      body: JSON.stringify({ acknowledgement }),
      redirect: "error",
      cache: "no-store",
    });

    if (response.ok) return;

    const payload = await safeJson(response);
    throw new CommandTransportError(
      "Kairoseth Platform rejected the command acknowledgement.",
      response.status,
      responseCode(payload),
    );
  }
}

function normalizedBaseUrl(value: string, allowInsecureHttp: boolean): URL {
  const url = new URL(value);

  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      "Command transport base URL must not contain credentials, query, or fragment.",
    );
  }

  const localHost =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1";

  if (url.protocol !== "https:" && !(allowInsecureHttp || localHost)) {
    throw new Error("Command transport requires HTTPS outside local development.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Command transport only supports HTTP(S) URLs.");
  }

  return url;
}

function endpoint(baseUrl: URL, path: string): URL {
  if (!path.startsWith("/")) {
    throw new Error("Command transport endpoint paths must be absolute paths.");
  }
  return new URL(path, baseUrl);
}

function bearerJsonHeaders(accessToken: string): HeadersInit {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${accessToken}`,
    "Cache-Control": "no-store",
    "Content-Type": "application/json",
  };
}

function requireCredential(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`Command transport ${field} is required.`);
  return normalized;
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function responseCode(payload: unknown): string {
  if (
    payload &&
    typeof payload === "object" &&
    "code" in payload &&
    typeof (payload as { code?: unknown }).code === "string"
  ) {
    const candidate = (payload as { code: string }).code.trim();
    if (/^[A-Za-z0-9_.-]{1,96}$/.test(candidate)) return candidate;
  }
  return "platform_request_failed";
}

function isCommandBatch(value: unknown, limit: number): value is CommandBatch {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CommandBatch>;

  return (
    candidate.version === "kab.command-batch.v1" &&
    typeof candidate.batchId === "string" &&
    candidate.batchId.length > 0 &&
    typeof candidate.sessionId === "string" &&
    candidate.sessionId.length > 0 &&
    Array.isArray(candidate.commands) &&
    candidate.commands.length <= limit
  );
}

import type { InstallationBinding } from "./enrollment.js";
import type {
  HeartbeatAck,
  HeartbeatPayload,
  OutboundSessionTransport,
  SessionChallenge,
  SessionCredential,
} from "./session.js";
import type { SignedSessionProof } from "./session-proof.js";

export interface HttpSessionTransportOptions {
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  challengePath?: string;
  openPath?: string;
  heartbeatPath?: string;
  allowInsecureHttp?: boolean;
}

export class SessionTransportError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly code: string,
  ) {
    super(message);
    this.name = "SessionTransportError";
  }
}

const DEFAULT_CHALLENGE_PATH = "/api/products/agent-bridge/session/challenge";
const DEFAULT_OPEN_PATH = "/api/products/agent-bridge/session/open";
const DEFAULT_HEARTBEAT_PATH = "/api/products/agent-bridge/session/heartbeat";

function normalizedBaseUrl(value: string, allowInsecureHttp: boolean): URL {
  const url = new URL(value);

  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Session base URL must not contain credentials, query, or fragment.");
  }

  const localHost =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1";

  if (url.protocol !== "https:" && !(allowInsecureHttp || localHost)) {
    throw new Error("Control session transport requires HTTPS outside local development.");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Control session transport only supports HTTP(S) URLs.");
  }

  return url;
}

function endpoint(baseUrl: URL, path: string): URL {
  if (!path.startsWith("/")) {
    throw new Error("Control session endpoint paths must be absolute paths.");
  }
  return new URL(path, baseUrl);
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
    return (payload as { code: string }).code.slice(0, 96);
  }
  return "platform_request_failed";
}

function jsonHeaders(): HeadersInit {
  return {
    Accept: "application/json",
    "Cache-Control": "no-store",
    "Content-Type": "application/json",
  };
}

function bearerHeaders(accessToken: string): HeadersInit {
  const token = accessToken.trim();
  if (!token) throw new Error("Control session access token is required.");

  return {
    ...jsonHeaders(),
    Authorization: `Bearer ${token}`,
  };
}

function requireObject<T>(
  payload: unknown,
  status: number,
  code: string,
  message: string,
): T {
  if (!payload || typeof payload !== "object") {
    throw new SessionTransportError(message, status, code);
  }
  return payload as T;
}

export class HttpSessionTransport implements OutboundSessionTransport {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly challengeUrl: URL;
  private readonly openUrl: URL;
  private readonly heartbeatUrl: URL;

  constructor(options: HttpSessionTransportOptions) {
    const baseUrl = normalizedBaseUrl(
      options.baseUrl,
      options.allowInsecureHttp ?? false,
    );
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.challengeUrl = endpoint(
      baseUrl,
      options.challengePath ?? DEFAULT_CHALLENGE_PATH,
    );
    this.openUrl = endpoint(baseUrl, options.openPath ?? DEFAULT_OPEN_PATH);
    this.heartbeatUrl = endpoint(
      baseUrl,
      options.heartbeatPath ?? DEFAULT_HEARTBEAT_PATH,
    );
  }

  async requestSessionChallenge(
    binding: InstallationBinding,
  ): Promise<SessionChallenge> {
    const response = await this.fetchImpl(this.challengeUrl, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        tenantId: binding.tenantId,
        installationId: binding.installationId,
        bridgeInstanceId: binding.bridgeInstanceId,
        keyId: binding.keyId,
      }),
      redirect: "error",
      cache: "no-store",
    });
    const payload = await safeJson(response);
    if (!response.ok) {
      throw new SessionTransportError(
        "Kairoseth Platform rejected the session challenge request.",
        response.status,
        responseCode(payload),
      );
    }
    return requireObject<SessionChallenge>(
      payload,
      response.status,
      "invalid_session_challenge_response",
      "Kairoseth Platform returned an invalid session challenge.",
    );
  }

  async openSession(proof: SignedSessionProof): Promise<SessionCredential> {
    const response = await this.fetchImpl(this.openUrl, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ proof }),
      redirect: "error",
      cache: "no-store",
    });
    const payload = await safeJson(response);
    if (!response.ok) {
      throw new SessionTransportError(
        "Kairoseth Platform rejected the control session.",
        response.status,
        responseCode(payload),
      );
    }

    const object = requireObject<{ credential?: unknown }>(
      payload,
      response.status,
      "invalid_session_credential_response",
      "Kairoseth Platform returned an invalid session credential.",
    );
    if (!object.credential || typeof object.credential !== "object") {
      throw new SessionTransportError(
        "Kairoseth Platform returned an invalid session credential.",
        response.status,
        "invalid_session_credential_response",
      );
    }
    return object.credential as SessionCredential;
  }

  async sendHeartbeat(
    accessToken: string,
    heartbeat: HeartbeatPayload,
  ): Promise<HeartbeatAck> {
    const response = await this.fetchImpl(this.heartbeatUrl, {
      method: "POST",
      headers: bearerHeaders(accessToken),
      body: JSON.stringify({ heartbeat }),
      redirect: "error",
      cache: "no-store",
    });
    const payload = await safeJson(response);
    if (!response.ok) {
      throw new SessionTransportError(
        "Kairoseth Platform rejected the control heartbeat.",
        response.status,
        responseCode(payload),
      );
    }

    const object = requireObject<{ ack?: unknown }>(
      payload,
      response.status,
      "invalid_heartbeat_ack_response",
      "Kairoseth Platform returned an invalid heartbeat acknowledgement.",
    );
    if (!object.ack || typeof object.ack !== "object") {
      throw new SessionTransportError(
        "Kairoseth Platform returned an invalid heartbeat acknowledgement.",
        response.status,
        "invalid_heartbeat_ack_response",
      );
    }
    return object.ack as HeartbeatAck;
  }
}

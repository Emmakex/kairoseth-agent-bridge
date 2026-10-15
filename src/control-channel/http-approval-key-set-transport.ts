import type {
  ApprovalKeySetTransport,
} from "./approval-key-sync.js";
import type { SignedApprovalKeySet } from "../security/approval-keys.js";

export interface HttpApprovalKeySetTransportOptions {
  baseUrl: string;
  fetch?: typeof globalThis.fetch | undefined;
  endpoint?: string | undefined;
  allowInsecureHttp?: boolean | undefined;
}

export class ApprovalKeySetTransportError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly code: string,
  ) {
    super(message);
    this.name = "ApprovalKeySetTransportError";
  }
}

const DEFAULT_ENDPOINT = "/api/products/agent-bridge/approval-keys/sync";

export class HttpApprovalKeySetTransport implements ApprovalKeySetTransport {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly endpointUrl: URL;

  constructor(options: HttpApprovalKeySetTransportOptions) {
    const baseUrl = normalizedBaseUrl(
      options.baseUrl,
      options.allowInsecureHttp ?? false,
    );
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.endpointUrl = endpoint(baseUrl, options.endpoint ?? DEFAULT_ENDPOINT);
  }

  async fetchApprovalKeySet(
    accessToken: string,
    sessionId: string,
    currentGeneration: number,
  ): Promise<SignedApprovalKeySet | null> {
    const token = requireCredential(accessToken, "session access token");
    const session = requireCredential(sessionId, "session ID");
    if (!Number.isInteger(currentGeneration) || currentGeneration < 0) {
      throw new Error("Approval key generation must be a non-negative integer.");
    }

    const response = await this.fetchImpl(this.endpointUrl, {
      method: "POST",
      headers: bearerJsonHeaders(token),
      body: JSON.stringify({
        sessionId: session,
        currentGeneration,
      }),
      redirect: "error",
      cache: "no-store",
    });

    if (response.status === 204) return null;
    const payload = await safeJson(response);

    if (!response.ok) {
      throw new ApprovalKeySetTransportError(
        "Kairoseth Platform rejected the approval-key synchronization request.",
        response.status,
        responseCode(payload),
      );
    }

    if (!payload || typeof payload !== "object" || !("update" in payload)) {
      throw new ApprovalKeySetTransportError(
        "Kairoseth Platform returned an invalid approval-key synchronization response.",
        response.status,
        "invalid_approval_key_sync_response",
      );
    }

    const update = (payload as { update?: unknown }).update;
    if (update === null) return null;
    if (!isSignedApprovalKeySet(update)) {
      throw new ApprovalKeySetTransportError(
        "Kairoseth Platform returned an invalid signed approval keyset.",
        response.status,
        "invalid_signed_approval_keyset_response",
      );
    }

    return update;
  }
}

function normalizedBaseUrl(value: string, allowInsecureHttp: boolean): URL {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      "Approval key sync base URL must not contain credentials, query, or fragment.",
    );
  }

  const localHost =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1";

  if (url.protocol !== "https:" && !(allowInsecureHttp || localHost)) {
    throw new Error("Approval key sync requires HTTPS outside local development.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Approval key sync only supports HTTP(S) URLs.");
  }
  return url;
}

function endpoint(baseUrl: URL, path: string): URL {
  if (!path.startsWith("/")) {
    throw new Error("Approval key sync endpoint path must be absolute.");
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
  if (!normalized) throw new Error(`Approval key sync ${field} is required.`);
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

function isSignedApprovalKeySet(value: unknown): value is SignedApprovalKeySet {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SignedApprovalKeySet>;
  if (
    typeof candidate.signerKeyId !== "string" ||
    candidate.signerKeyId.length === 0 ||
    typeof candidate.signature !== "string" ||
    candidate.signature.length === 0 ||
    !candidate.payload ||
    typeof candidate.payload !== "object"
  ) {
    return false;
  }

  const payload = candidate.payload;
  return (
    payload.version === "kab.approval-keyset.v1" &&
    typeof payload.tenantId === "string" &&
    typeof payload.installationId === "string" &&
    typeof payload.bridgeInstanceId === "string" &&
    Number.isInteger(payload.generation) &&
    Array.isArray(payload.keys) &&
    typeof payload.issuedAt === "string"
  );
}

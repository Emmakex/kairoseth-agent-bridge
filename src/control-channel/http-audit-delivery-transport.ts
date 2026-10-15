import type {
  AuditBatch,
  AuditBatchAcknowledgement,
  AuditDeliveryTransport,
} from "./audit-delivery.js";

export interface HttpAuditDeliveryTransportOptions {
  baseUrl: string;
  fetch?: typeof globalThis.fetch | undefined;
  endpoint?: string | undefined;
  allowInsecureHttp?: boolean | undefined;
}

export class AuditDeliveryTransportError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly code: string,
  ) {
    super(message);
    this.name = "AuditDeliveryTransportError";
  }
}

const DEFAULT_ENDPOINT = "/api/products/agent-bridge/audit/batch";

export class HttpAuditDeliveryTransport implements AuditDeliveryTransport {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly endpointUrl: URL;

  constructor(options: HttpAuditDeliveryTransportOptions) {
    const baseUrl = normalizedBaseUrl(
      options.baseUrl,
      options.allowInsecureHttp ?? false,
    );
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.endpointUrl = endpoint(baseUrl, options.endpoint ?? DEFAULT_ENDPOINT);
  }

  async sendAuditBatch(
    accessToken: string,
    batch: AuditBatch,
  ): Promise<AuditBatchAcknowledgement> {
    const token = requireCredential(accessToken, "session access token");

    const response = await this.fetchImpl(this.endpointUrl, {
      method: "POST",
      headers: bearerJsonHeaders(token),
      body: JSON.stringify({ batch }),
      redirect: "error",
      cache: "no-store",
    });
    const payload = await safeJson(response);

    if (!response.ok) {
      throw new AuditDeliveryTransportError(
        "Kairoseth Platform rejected the audit batch.",
        response.status,
        responseCode(payload),
      );
    }

    const acknowledgement =
      payload && typeof payload === "object" && "ack" in payload
        ? (payload as { ack?: unknown }).ack
        : null;

    if (!isAuditAcknowledgement(acknowledgement)) {
      throw new AuditDeliveryTransportError(
        "Kairoseth Platform returned an invalid audit acknowledgement.",
        response.status,
        "invalid_audit_ack_response",
      );
    }

    return acknowledgement;
  }
}

function normalizedBaseUrl(value: string, allowInsecureHttp: boolean): URL {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      "Audit delivery base URL must not contain credentials, query, or fragment.",
    );
  }

  const localHost =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1";

  if (url.protocol !== "https:" && !(allowInsecureHttp || localHost)) {
    throw new Error("Audit delivery requires HTTPS outside local development.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Audit delivery only supports HTTP(S) URLs.");
  }
  return url;
}

function endpoint(baseUrl: URL, path: string): URL {
  if (!path.startsWith("/")) {
    throw new Error("Audit delivery endpoint path must be absolute.");
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
  if (!normalized) throw new Error(`Audit delivery ${field} is required.`);
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

function isAuditAcknowledgement(
  value: unknown,
): value is AuditBatchAcknowledgement {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<AuditBatchAcknowledgement>;
  return (
    candidate.version === "kab.audit-batch-ack.v1" &&
    typeof candidate.batchId === "string" &&
    candidate.batchId.length > 0 &&
    Array.isArray(candidate.acceptedEventIds) &&
    candidate.acceptedEventIds.every((item) => typeof item === "string")
  );
}

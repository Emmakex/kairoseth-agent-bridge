import type {
  RuntimeOperationalSnapshot,
  RuntimeSnapshotAck,
  RuntimeSnapshotTransport,
} from "./runtime-snapshot.js";

export class RuntimeSnapshotTransportError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(`Runtime snapshot transport failed with HTTP ${status} (${code}).`);
    this.name = "RuntimeSnapshotTransportError";
    this.status = status;
    this.code = code;
  }
}

export interface HttpRuntimeSnapshotTransportOptions {
  baseUrl: string;
  endpoint?: string | undefined;
  fetch?: typeof fetch | undefined;
  allowInsecureHttp?: boolean | undefined;
}

function normalizedBaseUrl(raw: string, allowInsecureHttp: boolean): URL {
  const url = new URL(raw);
  const localhost =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1";

  if (url.protocol !== "https:" && !(localhost || allowInsecureHttp)) {
    throw new Error("Runtime snapshot transport requires HTTPS outside localhost.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Runtime snapshot transport supports only HTTP(S) origins.");
  }

  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url;
}

function endpointUrl(baseUrl: URL, endpoint: string): URL {
  const path = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  return new URL(path, baseUrl);
}

async function boundedError(response: Response): Promise<RuntimeSnapshotTransportError> {
  let code = "runtime_snapshot_rejected";

  try {
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const payload = (await response.json()) as unknown;
      if (
        payload &&
        typeof payload === "object" &&
        "code" in payload &&
        typeof (payload as { code?: unknown }).code === "string"
      ) {
        const candidate = (payload as { code: string }).code.trim();
        if (/^[a-z0-9_.-]{1,96}$/i.test(candidate)) code = candidate;
      }
    }
  } catch {
    // Deliberately ignore raw response content.
  }

  return new RuntimeSnapshotTransportError(response.status, code);
}

function validAck(value: unknown): value is RuntimeSnapshotAck {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<RuntimeSnapshotAck>;
  return (
    candidate.version === "kab.runtime-snapshot-ack.v1" &&
    typeof candidate.snapshotId === "string" &&
    candidate.snapshotId.length > 0 &&
    typeof candidate.receivedAt === "string" &&
    Number.isFinite(Date.parse(candidate.receivedAt))
  );
}

export class HttpRuntimeSnapshotTransport implements RuntimeSnapshotTransport {
  private readonly baseUrl: URL;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpRuntimeSnapshotTransportOptions) {
    this.baseUrl = normalizedBaseUrl(
      options.baseUrl,
      options.allowInsecureHttp ?? false,
    );
    this.endpoint =
      options.endpoint ?? "/api/products/agent-bridge/runtime-snapshot";
    this.fetchImpl = options.fetch ?? fetch;
  }

  async report(
    accessToken: string,
    snapshot: RuntimeOperationalSnapshot,
  ): Promise<RuntimeSnapshotAck> {
    if (!accessToken.trim()) {
      throw new Error("Runtime snapshot transport requires a session access token.");
    }

    const url = endpointUrl(this.baseUrl, this.endpoint);
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ snapshot }),
      redirect: "error",
      cache: "no-store",
    });

    if (!response.ok) throw await boundedError(response);

    const payload = (await response.json()) as unknown;
    const ack =
      payload && typeof payload === "object" && "ack" in payload
        ? (payload as { ack?: unknown }).ack
        : null;

    if (!validAck(ack)) {
      throw new RuntimeSnapshotTransportError(
        response.status,
        "invalid_runtime_snapshot_ack",
      );
    }

    return ack;
  }
}

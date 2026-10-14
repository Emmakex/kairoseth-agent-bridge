import type {
  EnrollmentChallenge,
  InstallationBinding,
  OutboundEnrollmentTransport,
} from "./enrollment.js";
import type { SignedRegistrationProof } from "../identity/registration-proof.js";

export interface HttpEnrollmentTransportOptions {
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  challengePath?: string;
  registerPath?: string;
  allowInsecureHttp?: boolean;
}

export class EnrollmentTransportError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly code: string,
  ) {
    super(message);
    this.name = "EnrollmentTransportError";
  }
}

const DEFAULT_CHALLENGE_PATH =
  "/api/products/agent-bridge/enrollment/challenge";
const DEFAULT_REGISTER_PATH =
  "/api/products/agent-bridge/enrollment/register";

function normalizedBaseUrl(value: string, allowInsecureHttp: boolean): URL {
  const url = new URL(value);

  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Enrollment base URL must not contain credentials, query, or fragment.");
  }

  const localHost =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1";

  if (url.protocol !== "https:" && !(allowInsecureHttp || localHost)) {
    throw new Error("Enrollment transport requires HTTPS outside local development.");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Enrollment transport only supports HTTP(S) URLs.");
  }

  return url;
}

function endpoint(baseUrl: URL, path: string): URL {
  if (!path.startsWith("/")) {
    throw new Error("Enrollment endpoint paths must be absolute paths.");
  }

  return new URL(path, baseUrl);
}

function authorizationHeaders(enrollmentToken: string): HeadersInit {
  const token = enrollmentToken.trim();
  if (!token) {
    throw new Error("Enrollment token is required.");
  }

  return {
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
    "Cache-Control": "no-store",
  };
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

export class HttpEnrollmentTransport implements OutboundEnrollmentTransport {
  private readonly baseUrl: URL;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly challengeUrl: URL;
  private readonly registerUrl: URL;

  constructor(options: HttpEnrollmentTransportOptions) {
    this.baseUrl = normalizedBaseUrl(
      options.baseUrl,
      options.allowInsecureHttp ?? false,
    );
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.challengeUrl = endpoint(
      this.baseUrl,
      options.challengePath ?? DEFAULT_CHALLENGE_PATH,
    );
    this.registerUrl = endpoint(
      this.baseUrl,
      options.registerPath ?? DEFAULT_REGISTER_PATH,
    );
  }

  async requestChallenge(
    enrollmentToken: string,
  ): Promise<EnrollmentChallenge> {
    const response = await this.fetchImpl(this.challengeUrl, {
      method: "POST",
      headers: authorizationHeaders(enrollmentToken),
      redirect: "error",
      cache: "no-store",
    });
    const payload = await safeJson(response);

    if (!response.ok) {
      throw new EnrollmentTransportError(
        "Kairoseth Platform rejected the enrollment challenge request.",
        response.status,
        responseCode(payload),
      );
    }

    if (!payload || typeof payload !== "object") {
      throw new EnrollmentTransportError(
        "Kairoseth Platform returned an invalid enrollment challenge.",
        response.status,
        "invalid_challenge_response",
      );
    }

    return payload as EnrollmentChallenge;
  }

  async register(
    enrollmentToken: string,
    proof: SignedRegistrationProof,
  ): Promise<InstallationBinding> {
    const response = await this.fetchImpl(this.registerUrl, {
      method: "POST",
      headers: {
        ...authorizationHeaders(enrollmentToken),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ proof }),
      redirect: "error",
      cache: "no-store",
    });
    const payload = await safeJson(response);

    if (!response.ok) {
      throw new EnrollmentTransportError(
        "Kairoseth Platform rejected installation registration.",
        response.status,
        responseCode(payload),
      );
    }

    if (
      !payload ||
      typeof payload !== "object" ||
      !("binding" in payload) ||
      !(payload as { binding?: unknown }).binding
    ) {
      throw new EnrollmentTransportError(
        "Kairoseth Platform returned an invalid installation binding.",
        response.status,
        "invalid_binding_response",
      );
    }

    return (payload as { binding: InstallationBinding }).binding;
  }
}

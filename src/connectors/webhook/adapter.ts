import {
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";

import { requireConnectorSecret } from "../sdk/secrets.js";
import type {
  NormalizedWebhookEvent,
  WebhookAdapterContext,
  WebhookAuthDefinition,
  WebhookDefinition,
  WebhookEventSink,
  WebhookHandlingResult,
  WebhookHttpRequest,
} from "./contracts.js";
import { WebhookError } from "./errors.js";
import type {
  WebhookReplayRecord,
  WebhookReplayStore,
} from "./replay.js";

const DEFAULT_TIMESTAMP_HEADER = "x-kairoseth-timestamp";
const DEFAULT_NONCE_HEADER = "x-kairoseth-nonce";
const DEFAULT_SIGNATURE_HEADER = "x-kairoseth-signature";
const DEFAULT_TOLERANCE_SECONDS = 300;
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const NONCE_PATTERN = /^[^\s\r\n]{8,256}$/;
const SENSITIVE_KEYS = [
  "authorization",
  "password",
  "passwd",
  "secret",
  "token",
  "access_token",
  "refresh_token",
  "api_key",
  "apikey",
  "cookie",
  "private_key",
  "client_secret",
];

export interface WebhookAdapterOptions {
  now?: (() => Date) | undefined;
}

export class WebhookAdapter {
  private readonly now: () => Date;

  constructor(
    private readonly replayStore: WebhookReplayStore,
    private readonly sink: WebhookEventSink,
    options: WebhookAdapterOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async handle(
    definition: WebhookDefinition,
    request: WebhookHttpRequest,
    context: WebhookAdapterContext,
  ): Promise<WebhookHandlingResult> {
    validateWebhookDefinition(definition);
    validateRequestEnvelope(definition, request);

    const replay = normalizeReplayPolicy(definition);
    const timestampValue = requireSingleHeader(request.headers, replay.timestampHeader);
    const nonce = requireSingleHeader(request.headers, replay.nonceHeader);
    const sourceTimestamp = validateTimestamp(
      timestampValue,
      this.now(),
      replay.toleranceSeconds,
    );
    validateNonce(nonce);

    const authSecrets = await verifyAuthentication(
      definition.auth,
      request,
      timestampValue,
      nonce,
      context,
    );

    const payloadFingerprint = createHash("sha256")
      .update(request.body)
      .digest("base64url");
    const eventId = createHash("sha256")
      .update(`kab.webhook-event.v1\u0000${definition.id}\u0000${nonce}`, "utf8")
      .digest("base64url");

    const parsed = parseJsonBody(request, definition);
    const payload = redactWebhookPayload(
      parsed,
      authSecrets,
      definition.redactKeys ?? [],
    );
    const receivedAt = this.now().toISOString();
    const event: NormalizedWebhookEvent = {
      version: "kab.webhook-event.v1",
      eventId,
      webhookId: definition.id,
      receivedAt,
      sourceTimestamp,
      nonce,
      payloadFingerprint,
      payload,
    };

    // Sink contract is idempotent by eventId. Persist first so a crash before nonce
    // consumption can be recovered by redelivery without losing the event.
    await this.sink.emit(event);

    const retainUntil = new Date(
      this.now().getTime() + replay.retainSeconds * 1000,
    ).toISOString();
    const record: WebhookReplayRecord = {
      version: "kab.webhook-replay.v1",
      webhookId: definition.id,
      nonce,
      sourceTimestamp,
      payloadFingerprint,
      consumedAt: this.now().toISOString(),
      retainUntil,
    };

    const consumed = await this.replayStore.consume(record);
    if (consumed) {
      return { accepted: true, eventId, duplicate: false };
    }

    const existing = await this.replayStore.get(definition.id, nonce);
    if (
      !existing ||
      existing.payloadFingerprint !== payloadFingerprint ||
      existing.sourceTimestamp !== sourceTimestamp
    ) {
      throw new WebhookError(
        "replay_conflict",
        "Webhook nonce was already used for a different authenticated delivery.",
      );
    }

    return { accepted: true, eventId, duplicate: true };
  }
}

interface NormalizedReplayPolicy {
  timestampHeader: string;
  nonceHeader: string;
  toleranceSeconds: number;
  retainSeconds: number;
}

export function validateWebhookDefinition(definition: WebhookDefinition): void {
  if (!ID_PATTERN.test(definition.id)) {
    throw new Error("Webhook ID is invalid.");
  }
  if (!definition.name.trim() || !definition.description.trim()) {
    throw new Error("Webhook name and description are required.");
  }
  if (
    !definition.path.startsWith("/") ||
    definition.path.startsWith("//") ||
    definition.path.includes("?") ||
    definition.path.includes("#") ||
    definition.path.includes("\\") ||
    /(^|\/)\.\.?(\/|$)/.test(definition.path)
  ) {
    throw new Error("Webhook path is unsafe.");
  }

  validateAuthDefinition(definition.auth);
  normalizeReplayPolicy(definition);
  validateMaxBodyBytes(definition.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);

  for (const key of definition.redactKeys ?? []) {
    if (!key.trim() || key.length > 128) {
      throw new Error("Webhook redactKeys must contain non-empty keys up to 128 characters.");
    }
  }
}

function validateRequestEnvelope(
  definition: WebhookDefinition,
  request: WebhookHttpRequest,
): void {
  if (request.method.toUpperCase() !== "POST") {
    throw new WebhookError("invalid_request", "Webhook request must use POST.");
  }
  if (request.path !== definition.path) {
    throw new WebhookError("invalid_request", "Webhook request path does not match definition.");
  }

  const maxBytes = validateMaxBodyBytes(
    definition.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
  );
  if (request.body.byteLength > maxBytes) {
    throw new WebhookError(
      "payload_too_large",
      `Webhook payload exceeds ${maxBytes} bytes.`,
    );
  }

  const contentType = optionalSingleHeader(request.headers, "content-type");
  if (contentType) {
    const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
    if (mediaType !== "application/json" && !mediaType?.endsWith("+json")) {
      throw new WebhookError(
        "invalid_request",
        "Webhook content type must be JSON.",
      );
    }
  }
}

function normalizeReplayPolicy(definition: WebhookDefinition): NormalizedReplayPolicy {
  const policy = definition.replay;
  const timestampHeader = normalizeHeaderName(
    policy?.timestampHeader ?? DEFAULT_TIMESTAMP_HEADER,
  );
  const nonceHeader = normalizeHeaderName(
    policy?.nonceHeader ?? DEFAULT_NONCE_HEADER,
  );
  const toleranceSeconds = policy?.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const retainSeconds = policy?.retainSeconds ?? toleranceSeconds * 2;

  if (
    !Number.isInteger(toleranceSeconds) ||
    toleranceSeconds < 30 ||
    toleranceSeconds > 3600
  ) {
    throw new Error("Webhook replay toleranceSeconds must be between 30 and 3600.");
  }
  if (
    !Number.isInteger(retainSeconds) ||
    retainSeconds < toleranceSeconds ||
    retainSeconds > 604800
  ) {
    throw new Error(
      "Webhook replay retainSeconds must be at least toleranceSeconds and at most 604800.",
    );
  }
  if (timestampHeader === nonceHeader) {
    throw new Error("Webhook timestamp and nonce headers must be different.");
  }

  return {
    timestampHeader,
    nonceHeader,
    toleranceSeconds,
    retainSeconds,
  };
}

function validateAuthDefinition(auth: WebhookAuthDefinition): void {
  if (!auth.requirementId.trim()) {
    throw new Error("Webhook auth requirementId is required.");
  }

  if (auth.type === "hmac_sha256") {
    if (!auth.secretField.trim()) {
      throw new Error("Webhook HMAC secretField is required.");
    }
    normalizeHeaderName(auth.signatureHeader ?? DEFAULT_SIGNATURE_HEADER);
    const prefix = auth.signaturePrefix ?? "sha256=";
    if (/\r|\n/.test(prefix) || prefix.length > 32) {
      throw new Error("Webhook HMAC signaturePrefix is invalid.");
    }
    return;
  }

  if (!auth.tokenField.trim()) {
    throw new Error("Webhook bearer tokenField is required.");
  }
  normalizeHeaderName(auth.authorizationHeader ?? "authorization");
}

async function verifyAuthentication(
  auth: WebhookAuthDefinition,
  request: WebhookHttpRequest,
  timestamp: string,
  nonce: string,
  context: WebhookAdapterContext,
): Promise<readonly string[]> {
  if (auth.type === "hmac_sha256") {
    const secret = await requireConnectorSecret(
      context.secrets,
      auth.requirementId,
      auth.secretField,
    );
    const header = normalizeHeaderName(
      auth.signatureHeader ?? DEFAULT_SIGNATURE_HEADER,
    );
    const supplied = requireSingleHeader(request.headers, header);
    const prefix = auth.signaturePrefix ?? "sha256=";
    if (!supplied.startsWith(prefix)) {
      throw new WebhookError(
        "authentication_failed",
        "Webhook signature format is invalid.",
      );
    }

    const suppliedHex = supplied.slice(prefix.length);
    if (!/^[a-f0-9]{64}$/i.test(suppliedHex)) {
      throw new WebhookError(
        "authentication_failed",
        "Webhook signature format is invalid.",
      );
    }

    const hmac = createHmac("sha256", secret);
    hmac.update(`${timestamp}.${nonce}.`, "utf8");
    hmac.update(request.body);
    const expected = hmac.digest();
    const suppliedBytes = Buffer.from(suppliedHex, "hex");

    if (
      suppliedBytes.length !== expected.length ||
      !timingSafeEqual(suppliedBytes, expected)
    ) {
      throw new WebhookError(
        "authentication_failed",
        "Webhook authentication failed.",
      );
    }
    return [secret];
  }

  const token = await requireConnectorSecret(
    context.secrets,
    auth.requirementId,
    auth.tokenField,
  );
  const header = normalizeHeaderName(
    auth.authorizationHeader ?? "authorization",
  );
  const supplied = requireSingleHeader(request.headers, header);
  const expected = `Bearer ${token}`;

  if (!safeEqualStrings(supplied, expected)) {
    throw new WebhookError(
      "authentication_failed",
      "Webhook authentication failed.",
    );
  }
  return [token];
}

function validateTimestamp(
  value: string,
  now: Date,
  toleranceSeconds: number,
): string {
  if (!/^\d{10,13}$/.test(value)) {
    throw new WebhookError(
      "timestamp_rejected",
      "Webhook timestamp must be Unix seconds.",
    );
  }

  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric)) {
    throw new WebhookError("timestamp_rejected", "Webhook timestamp is invalid.");
  }

  const milliseconds = value.length === 13 ? numeric : numeric * 1000;
  const delta = Math.abs(now.getTime() - milliseconds);
  if (delta > toleranceSeconds * 1000) {
    throw new WebhookError(
      "timestamp_rejected",
      "Webhook timestamp is outside the accepted clock window.",
    );
  }

  return new Date(milliseconds).toISOString();
}

function validateNonce(value: string): void {
  if (!NONCE_PATTERN.test(value)) {
    throw new WebhookError(
      "invalid_request",
      "Webhook nonce must be an opaque 8-256 character value without whitespace.",
    );
  }
}

function parseJsonBody(
  request: WebhookHttpRequest,
  definition: WebhookDefinition,
): unknown {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(request.body);
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new WebhookError(
      "invalid_payload",
      `Webhook ${definition.id} payload is not valid UTF-8 JSON.`,
      { cause: error },
    );
  }
}

function redactWebhookPayload(
  value: unknown,
  secrets: readonly string[],
  extraKeys: readonly string[],
  depth = 0,
): unknown {
  if (depth > 32) return "[TRUNCATED]";

  if (typeof value === "string") {
    let output = value;
    for (const secret of secrets) {
      if (secret) output = output.split(secret).join("[REDACTED]");
    }
    output = output.replace(
      /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
      "Bearer [REDACTED]",
    );
    return output;
  }

  if (Array.isArray(value)) {
    return value.map((item) =>
      redactWebhookPayload(item, secrets, extraKeys, depth + 1),
    );
  }

  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(key, extraKeys)) {
        result[key] = "[REDACTED]";
      } else {
        result[key] = redactWebhookPayload(
          child,
          secrets,
          extraKeys,
          depth + 1,
        );
      }
    }
    return result;
  }

  return value;
}

function isSensitiveKey(key: string, extraKeys: readonly string[]): boolean {
  const normalized = normalizeKey(key);
  const candidates = [...SENSITIVE_KEYS, ...extraKeys]
    .map(normalizeKey)
    .filter(Boolean);
  return candidates.some(
    (candidate) => normalized === candidate || normalized.includes(candidate),
  );
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function safeEqualStrings(left: string, right: string): boolean {
  const leftHash = createHash("sha256").update(left, "utf8").digest();
  const rightHash = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(leftHash, rightHash);
}

function requireSingleHeader(
  headers: WebhookHttpRequest["headers"],
  name: string,
): string {
  const value = optionalSingleHeader(headers, name);
  if (!value) {
    throw new WebhookError(
      "invalid_request",
      `Required webhook header is missing: ${name}`,
    );
  }
  return value;
}

function optionalSingleHeader(
  headers: WebhookHttpRequest["headers"],
  name: string,
): string | null {
  const normalized = name.toLowerCase();
  const matches = Object.entries(headers).filter(
    ([key, value]) => key.toLowerCase() === normalized && value !== undefined,
  );

  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new WebhookError(
      "invalid_request",
      `Webhook header appears multiple times: ${name}`,
    );
  }

  const value = matches[0]?.[1];
  if (Array.isArray(value)) {
    if (value.length !== 1) {
      throw new WebhookError(
        "invalid_request",
        `Webhook header must have exactly one value: ${name}`,
      );
    }
    return value[0]?.trim() || null;
  }

  return typeof value === "string" ? value.trim() || null : null;
}

function normalizeHeaderName(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized || /[\s\r\n:]/.test(normalized)) {
    throw new Error(`Webhook header name is invalid: ${value}`);
  }
  return normalized;
}

function validateMaxBodyBytes(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_BODY_BYTES) {
    throw new Error(`Webhook maxBodyBytes must be between 1 and ${MAX_BODY_BYTES}.`);
  }
  return value;
}

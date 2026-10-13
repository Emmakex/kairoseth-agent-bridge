import {
  ConnectorError,
  ConnectorTransientError,
} from "../sdk/errors.js";
import { requireConnectorSecret } from "../sdk/secrets.js";
import type {
  ConnectorCredentialRequirement,
  ConnectorDefinition,
  ConnectorHealthResult,
  ConnectorToolDefinition,
} from "../sdk/contracts.js";
import type {
  GenericRestAuth,
  GenericRestConnectorOptions,
  GenericRestHttpRuntime,
  GenericRestOperation,
  GenericRestResult,
} from "./contracts.js";
import {
  buildGenericRestUrl,
  defaultGenericRestHttpRuntime,
  validateGenericRestBaseUrl,
} from "./network.js";

const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
const MAX_RESPONSE_BYTES = 10 * 1_048_576;
const PATH_FIELD_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PROHIBITED_STATIC_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "forwarded",
]);
const DEFAULT_REDACT_KEYS = new Set([
  "password",
  "passwd",
  "secret",
  "token",
  "access_token",
  "refresh_token",
  "api_key",
  "apikey",
  "authorization",
  "cookie",
  "set-cookie",
  "client_secret",
]);

export function createGenericRestConnector(
  options: GenericRestConnectorOptions,
  runtime: GenericRestHttpRuntime = defaultGenericRestHttpRuntime,
): ConnectorDefinition {
  validateOptions(options);

  const auth = options.auth ?? { type: "none" as const };
  const maxBytes = options.response?.maxBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const redactKeys = new Set([
    ...DEFAULT_REDACT_KEYS,
    ...(options.response?.redactKeys ?? []).map((key) => key.toLowerCase()),
  ]);

  const tools: ConnectorToolDefinition[] = options.operations.map((operation) => ({
    id: operation.id,
    name: operation.name,
    description: operation.description,
    risk: operation.risk,
    inputSchema: operation.inputSchema,
    ...(operation.outputSchema ? { outputSchema: operation.outputSchema } : {}),
    ...(operation.behavior ? { behavior: operation.behavior } : {}),
    execute: async (input, context) =>
      await executeOperation(
        operation,
        input,
        context.config,
        context.secrets,
        context.signal,
        auth,
        options,
        runtime,
        maxBytes,
        redactKeys,
      ),
  }));

  return {
    manifest: {
      id: "generic-rest",
      name: options.name ?? "Generic REST",
      version: options.version ?? "1.0.0",
      description:
        options.description ??
        "Expose a predeclared REST API surface as normalized Agent Bridge tools.",
      capabilities: options.operations.map((operation) => operation.id),
      configSchema: {
        type: "object",
        properties: {
          baseUrl: {
            type: "string",
            format: "uri",
            description: "Base URL controlled by connector instance configuration.",
          },
        },
        required: ["baseUrl"],
        additionalProperties: false,
      },
      credentials: credentialRequirements(auth),
    },
    tools,
    health: async (context): Promise<ConnectorHealthResult> => {
      const checkedAt = new Date().toISOString();

      try {
        const baseUrl = await validateGenericRestBaseUrl(
          context.config.baseUrl,
          options.network,
          runtime,
        );

        if (!options.healthPath) {
          return {
            status: "healthy",
            checkedAt,
            message: "Generic REST base URL passed connector network policy.",
          };
        }

        const url = buildGenericRestUrl(baseUrl, options.healthPath);
        const headers = await buildAuthHeaders(auth, context.secrets);
        headers.set("accept", "application/json, text/plain;q=0.9, */*;q=0.1");

        const response = await runtime.fetch(url.toString(), {
          method: "GET",
          headers,
          redirect: "manual",
          signal: context.signal,
        });

        if (isRedirect(response.status)) {
          return {
            status: "unhealthy",
            checkedAt,
            message: `Generic REST health endpoint returned blocked redirect ${response.status}.`,
          };
        }

        return response.ok
          ? {
              status: "healthy",
              checkedAt,
              message: `Generic REST health endpoint returned ${response.status}.`,
            }
          : {
              status: response.status >= 500 ? "unhealthy" : "degraded",
              checkedAt,
              message: `Generic REST health endpoint returned ${response.status}.`,
            };
      } catch (error) {
        return {
          status: "unhealthy",
          checkedAt,
          message:
            error instanceof Error
              ? `Generic REST health check failed: ${safeErrorMessage(error.message)}`
              : "Generic REST health check failed.",
        };
      }
    },
  };
}

async function executeOperation(
  operation: GenericRestOperation,
  input: unknown,
  config: Readonly<Record<string, unknown>>,
  secrets: { getSecret(requirementId: string, fieldId: string): Promise<string | null> },
  signal: AbortSignal,
  auth: GenericRestAuth,
  options: GenericRestConnectorOptions,
  runtime: GenericRestHttpRuntime,
  maxBytes: number,
  redactKeys: ReadonlySet<string>,
): Promise<GenericRestResult> {
  const baseUrl = await validateGenericRestBaseUrl(
    config.baseUrl,
    options.network,
    runtime,
  );
  const path = interpolatePath(operation.pathTemplate, input);
  const query = buildQuery(operation.query, input);
  const url = buildGenericRestUrl(baseUrl, path, query);
  const headers = await buildAuthHeaders(auth, secrets);

  headers.set("accept", "application/json, text/plain;q=0.9, */*;q=0.1");

  for (const [name, value] of Object.entries(operation.headers ?? {})) {
    headers.set(name, value);
  }

  let body: string | undefined;
  if (operation.body) {
    const bodyValue =
      operation.body.source === "input"
        ? input
        : getTopLevelField(input, operation.body.field ?? "");
    body = JSON.stringify(bodyValue);
    headers.set("content-type", "application/json");
  }

  let response: Response;
  try {
    response = await runtime.fetch(url.toString(), {
      method: operation.method,
      headers,
      ...(body !== undefined ? { body } : {}),
      redirect: "manual",
      signal,
    });
  } catch (error) {
    if (signal.aborted) {
      throw error;
    }

    throw new ConnectorTransientError(
      `Generic REST request failed before receiving a response for ${operation.id}.`,
      { cause: error },
    );
  }

  if (isRedirect(response.status)) {
    throw new ConnectorError(
      `Generic REST operation ${operation.id} returned blocked redirect ${response.status}.`,
    );
  }

  const responseBody = await readResponseBody(response, maxBytes, redactKeys);

  if (!response.ok) {
    const message = `Generic REST operation ${operation.id} returned HTTP ${response.status}.`;

    if (isTransientHttpStatus(response.status)) {
      throw new ConnectorTransientError(message);
    }

    throw new ConnectorError(message);
  }

  return {
    status: response.status,
    ok: true,
    body: responseBody,
  };
}

function credentialRequirements(
  auth: GenericRestAuth,
): readonly ConnectorCredentialRequirement[] {
  if (auth.type === "none") return [];

  if (auth.type === "bearer") {
    return [
      {
        id: auth.requirementId ?? "auth",
        kind: "bearer",
        label: "Bearer authentication",
        required: true,
        fields: [
          {
            id: auth.tokenField ?? "token",
            label: "Bearer token",
            secret: true,
            required: true,
          },
        ],
      },
    ];
  }

  if (auth.type === "basic") {
    return [
      {
        id: auth.requirementId ?? "auth",
        kind: "basic",
        label: "HTTP Basic authentication",
        required: true,
        fields: [
          {
            id: auth.usernameField ?? "username",
            label: "Username",
            secret: false,
            required: true,
          },
          {
            id: auth.passwordField ?? "password",
            label: "Password",
            secret: true,
            required: true,
          },
        ],
      },
    ];
  }

  return [
    {
      id: auth.requirementId ?? "auth",
      kind: "api_key",
      label: "API key authentication",
      required: true,
      fields: [
        {
          id: auth.valueField ?? "api_key",
          label: "API key",
          secret: true,
          required: true,
        },
      ],
    },
  ];
}

async function buildAuthHeaders(
  auth: GenericRestAuth,
  secrets: { getSecret(requirementId: string, fieldId: string): Promise<string | null> },
): Promise<Headers> {
  const headers = new Headers();

  if (auth.type === "none") return headers;

  if (auth.type === "bearer") {
    const token = await requireConnectorSecret(
      secrets,
      auth.requirementId ?? "auth",
      auth.tokenField ?? "token",
    );
    headers.set("authorization", `Bearer ${token}`);
    return headers;
  }

  if (auth.type === "basic") {
    const requirementId = auth.requirementId ?? "auth";
    const username = await requireConnectorSecret(
      secrets,
      requirementId,
      auth.usernameField ?? "username",
    );
    const password = await requireConnectorSecret(
      secrets,
      requirementId,
      auth.passwordField ?? "password",
    );
    headers.set(
      "authorization",
      `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`,
    );
    return headers;
  }

  const apiKey = await requireConnectorSecret(
    secrets,
    auth.requirementId ?? "auth",
    auth.valueField ?? "api_key",
  );
  headers.set(auth.headerName, `${auth.prefix ?? ""}${apiKey}`);
  return headers;
}

function interpolatePath(template: string, input: unknown): string {
  return template.replace(/\{([^{}]+)\}/g, (_match, field: string) => {
    if (!PATH_FIELD_PATTERN.test(field)) {
      throw new ConnectorError(
        `Generic REST path placeholder is invalid: ${field}`,
      );
    }

    const value = getTopLevelField(input, field);
    if (!isQueryPrimitive(value)) {
      throw new ConnectorError(
        `Generic REST path field ${field} must be a string, number or boolean.`,
      );
    }

    return encodeURIComponent(String(value));
  });
}

function buildQuery(
  mapping: Readonly<Record<string, string>> | undefined,
  input: unknown,
): Readonly<Record<string, readonly string[]>> {
  if (!mapping) return {};

  const result: Record<string, string[]> = {};

  for (const [queryName, inputField] of Object.entries(mapping)) {
    const value = getTopLevelField(input, inputField);

    if (value === undefined || value === null) continue;

    if (Array.isArray(value)) {
      const values = value.map((item) => {
        if (!isQueryPrimitive(item)) {
          throw new ConnectorError(
            `Generic REST query field ${inputField} contains a non-primitive value.`,
          );
        }
        return String(item);
      });
      result[queryName] = values;
      continue;
    }

    if (!isQueryPrimitive(value)) {
      throw new ConnectorError(
        `Generic REST query field ${inputField} must be primitive or an array of primitives.`,
      );
    }

    result[queryName] = [String(value)];
  }

  return result;
}

function getTopLevelField(input: unknown, field: string): unknown {
  if (!field || input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ConnectorError(`Generic REST input field is unavailable: ${field}`);
  }

  return (input as Record<string, unknown>)[field];
}

function isQueryPrimitive(value: unknown): value is string | number | boolean {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

async function readResponseBody(
  response: Response,
  maxBytes: number,
  redactKeys: ReadonlySet<string>,
): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength) {
    const parsedLength = Number(declaredLength);
    if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
      throw new ConnectorError(
        `Generic REST response exceeds maximum size of ${maxBytes} bytes.`,
      );
    }
  }

  if (!response.body || response.status === 204 || response.status === 205) {
    return null;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("response too large").catch(() => undefined);
        throw new ConnectorError(
          `Generic REST response exceeds maximum size of ${maxBytes} bytes.`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  if (!text) return null;

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("json") || looksLikeJson(text)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new ConnectorError("Generic REST response declared JSON but could not be parsed.");
    }
    return redactJson(parsed, redactKeys);
  }

  return redactText(text, redactKeys);
}

function redactJson(value: unknown, redactKeys: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactJson(item, redactKeys));
  }

  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      result[key] = redactKeys.has(key.toLowerCase())
        ? "[REDACTED]"
        : redactJson(child, redactKeys);
    }
    return result;
  }

  return value;
}

function redactText(text: string, redactKeys: ReadonlySet<string>): string {
  let result = text.replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [REDACTED]");

  for (const key of redactKeys) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(
      new RegExp(`(${escaped}\\s*[:=]\\s*)[^\\s,;]+`, "gi"),
      "$1[REDACTED]",
    );
  }

  return result;
}

function looksLikeJson(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function isTransientHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

function safeErrorMessage(message: string): string {
  return message.replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [REDACTED]").slice(0, 256);
}

function validateOptions(options: GenericRestConnectorOptions): void {
  if (!Array.isArray(options.operations) || options.operations.length === 0) {
    throw new Error("Generic REST connector requires at least one operation.");
  }

  const ids = new Set<string>();
  for (const operation of options.operations) {
    if (ids.has(operation.id)) {
      throw new Error(`Generic REST connector has duplicate operation ID: ${operation.id}`);
    }
    ids.add(operation.id);

    validateOperation(operation);
  }

  const maxBytes = options.response?.maxBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (!Number.isInteger(maxBytes) || maxBytes < 1_024 || maxBytes > MAX_RESPONSE_BYTES) {
    throw new Error(
      `Generic REST max response size must be between 1024 and ${MAX_RESPONSE_BYTES} bytes.`,
    );
  }

  if (options.healthPath) validateStaticPath(options.healthPath, "healthPath");

  if (options.auth?.type === "api_key_header") {
    validateHeaderName(options.auth.headerName, true);
  }
}

function validateOperation(operation: GenericRestOperation): void {
  validateStaticPath(operation.pathTemplate, `operation ${operation.id} path`);

  if (operation.risk === "READ" && !["GET", "HEAD"].includes(operation.method)) {
    throw new Error(
      `Generic REST operation ${operation.id} cannot classify ${operation.method} as READ.`,
    );
  }

  if (["GET", "HEAD"].includes(operation.method) && operation.body) {
    throw new Error(`Generic REST operation ${operation.id} cannot send a body with ${operation.method}.`);
  }

  if (operation.body?.source === "field" && !operation.body.field?.trim()) {
    throw new Error(`Generic REST operation ${operation.id} body field is required.`);
  }

  for (const [name, value] of Object.entries(operation.headers ?? {})) {
    validateHeaderName(name, false);
    if (/\r|\n/.test(value)) {
      throw new Error(`Generic REST operation ${operation.id} contains an invalid header value.`);
    }
  }

  for (const [queryName, field] of Object.entries(operation.query ?? {})) {
    if (!queryName.trim() || /[&#=\r\n]/.test(queryName) || !PATH_FIELD_PATTERN.test(field)) {
      throw new Error(`Generic REST operation ${operation.id} contains invalid query mapping.`);
    }
  }
}

function validateStaticPath(path: string, label: string): void {
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("\\") ||
    path.includes("?") ||
    path.includes("#") ||
    /(^|\/)\.\.?($|\/)/.test(path)
  ) {
    throw new Error(`Generic REST ${label} must be a safe relative API path.`);
  }

  for (const placeholder of path.matchAll(/\{([^{}]+)\}/g)) {
    if (!PATH_FIELD_PATTERN.test(placeholder[1] ?? "")) {
      throw new Error(`Generic REST ${label} contains an invalid path placeholder.`);
    }
  }
}

function validateHeaderName(name: string, authGenerated: boolean): void {
  const normalized = name.toLowerCase();

  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) {
    throw new Error(`Generic REST header name is invalid: ${name}`);
  }

  if (
    normalized.startsWith("x-forwarded-") ||
    (!authGenerated && PROHIBITED_STATIC_HEADERS.has(normalized)) ||
    (authGenerated && ["host", "content-length", "transfer-encoding", "connection", "cookie", "proxy-authorization"].includes(normalized))
  ) {
    throw new Error(`Generic REST header is not allowed: ${name}`);
  }
}

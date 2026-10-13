import {
  ConnectorError,
  ConnectorTransientError,
} from "../sdk/errors.js";
import { requireConnectorSecret } from "../sdk/secrets.js";
import type { ConnectorToolExecutionContext } from "../sdk/contracts.js";
import type {
  GenericRestAuth,
  GenericRestConnectorOptions,
  GenericRestEndpointDefinition,
  GenericRestToolOutput,
} from "./contracts.js";

const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const ABSOLUTE_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const REDACTED = "[REDACTED]";
const SENSITIVE_HEADER_PATTERN =
  /(authorization|proxy-authorization|cookie|set-cookie|secret|token|api[-_]?key|private[-_]?key|client[-_]?secret)/i;
const FORBIDDEN_TRANSPORT_HEADERS = new Set([
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "keep-alive",
]);
const DEFAULT_SENSITIVE_KEYS = [
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
  "set_cookie",
  "private_key",
  "client_secret",
];

export interface GenericRestExecutionOptions {
  connectorOptions: GenericRestConnectorOptions;
  endpoint: GenericRestEndpointDefinition;
  defaultAuth: GenericRestAuth;
}

export async function executeGenericRestEndpoint(
  options: GenericRestExecutionOptions,
  input: unknown,
  context: ConnectorToolExecutionContext,
): Promise<GenericRestToolOutput> {
  const baseUrl = getBaseUrl(context.config, options.connectorOptions.allowHttp ?? false);
  const url = buildRequestUrl(baseUrl, options.endpoint, input);
  const headers = buildStaticHeaders(
    options.connectorOptions.defaultHeaders,
    options.endpoint.request.headers,
  );
  headers.set("accept", "application/json");

  const sensitiveValues: string[] = [];
  const auth = options.endpoint.auth ?? options.defaultAuth;
  await applyAuth(auth, url, headers, context, sensitiveValues);

  if (context.idempotencyKey) {
    headers.set("idempotency-key", context.idempotencyKey);
  }

  const body = buildRequestBody(options.endpoint, input);
  if (body !== undefined) {
    headers.set("content-type", "application/json");
  }

  const fetchImpl = options.connectorOptions.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new ConnectorError("Fetch implementation is unavailable for Generic REST connector.");
  }

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: options.endpoint.method,
      headers,
      body,
      signal: context.signal,
      redirect: "manual",
    });
  } catch (error) {
    if (context.signal.aborted) {
      throw error;
    }

    throw new ConnectorTransientError(
      `Generic REST endpoint ${options.endpoint.id} network request failed.`,
      { cause: error },
    );
  }

  if (response.status >= 300 && response.status < 400) {
    await discardResponseBody(response);
    throw new ConnectorError(
      `Generic REST endpoint ${options.endpoint.id} returned redirect status ${response.status}; redirects are disabled.`,
    );
  }

  if (!response.ok) {
    await discardResponseBody(response);

    if (isTransientStatus(response.status)) {
      throw new ConnectorTransientError(
        `Generic REST endpoint ${options.endpoint.id} returned transient HTTP status ${response.status}.`,
      );
    }

    throw new ConnectorError(
      `Generic REST endpoint ${options.endpoint.id} returned HTTP status ${response.status}.`,
    );
  }

  const policy = options.endpoint.response;
  const maxBytes = validateMaxBytes(policy?.maxBytes ?? DEFAULT_MAX_RESPONSE_BYTES);
  const raw = await readBoundedBody(response, maxBytes, options.endpoint.id);
  const mode = policy?.mode ?? "json";
  const extraRedactKeys = policy?.redactKeys ?? [];

  if (raw.byteLength === 0) {
    return { status: response.status, body: null };
  }

  const text = new TextDecoder().decode(raw);

  if (mode === "text") {
    return {
      status: response.status,
      body: redactText(text, sensitiveValues),
    };
  }

  assertJsonContentType(response, options.endpoint.id);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new ConnectorError(
      `Generic REST endpoint ${options.endpoint.id} returned invalid JSON.`,
      { cause: error },
    );
  }

  return {
    status: response.status,
    body: redactJson(parsed, sensitiveValues, extraRedactKeys),
  };
}

export function validateGenericRestEndpoint(
  endpoint: GenericRestEndpointDefinition,
): void {
  if (!endpoint.request.path.startsWith("/")) {
    throw new Error(`Generic REST endpoint ${endpoint.id} path must start with '/'.`);
  }

  if (
    endpoint.request.path.includes("\\") ||
    endpoint.request.path.includes("?") ||
    endpoint.request.path.includes("#") ||
    endpoint.request.path.startsWith("//") ||
    /(^|\/)\.\.?(\/|$)/.test(endpoint.request.path)
  ) {
    throw new Error(`Generic REST endpoint ${endpoint.id} path is unsafe.`);
  }

  const unresolved = endpoint.request.path.replace(/\{[A-Za-z0-9_.-]+\}/g, "");
  if (unresolved.includes("{") || unresolved.includes("}")) {
    throw new Error(`Generic REST endpoint ${endpoint.id} path template is invalid.`);
  }

  if (
    (endpoint.method === "GET" || endpoint.method === "HEAD") &&
    endpoint.request.bodyInputPath !== undefined
  ) {
    throw new Error(
      `Generic REST endpoint ${endpoint.id} ${endpoint.method} cannot declare a request body.`,
    );
  }

  validateStaticHeaders(endpoint.request.headers, `endpoint ${endpoint.id}`);
  validateMaxBytes(endpoint.response?.maxBytes ?? DEFAULT_MAX_RESPONSE_BYTES);
  validateAuth(endpoint.auth, `endpoint ${endpoint.id}`);

  for (const [name, path] of Object.entries(endpoint.request.query ?? {})) {
    if (!name.trim() || /[\r\n]/.test(name)) {
      throw new Error(`Generic REST endpoint ${endpoint.id} query parameter name is invalid.`);
    }
    if (!path.trim()) {
      throw new Error(`Generic REST endpoint ${endpoint.id} query mapping path is required.`);
    }
  }
}

export function validateGenericRestConnectorOptions(
  options: GenericRestConnectorOptions,
): void {
  if (!Array.isArray(options.endpoints) || options.endpoints.length === 0) {
    throw new Error("Generic REST connector must declare at least one endpoint.");
  }

  validateStaticHeaders(options.defaultHeaders, "connector");
  validateAuth(options.auth, "connector");

  const ids = new Set<string>();
  for (const endpoint of options.endpoints) {
    if (ids.has(endpoint.id)) {
      throw new Error(`Generic REST connector declares duplicate endpoint ID: ${endpoint.id}`);
    }
    ids.add(endpoint.id);
    validateGenericRestEndpoint(endpoint);
  }
}

function getBaseUrl(
  config: Readonly<Record<string, unknown>>,
  allowHttp: boolean,
): URL {
  const raw = config.baseUrl;
  if (typeof raw !== "string" || !raw.trim()) {
    throw new ConnectorError("Generic REST connector requires config.baseUrl.");
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    throw new ConnectorError("Generic REST connector baseUrl is invalid.", {
      cause: error,
    });
  }

  if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) {
    throw new ConnectorError(
      "Generic REST connector baseUrl must use HTTPS unless allowHttp is explicitly enabled.",
    );
  }

  if (url.username || url.password) {
    throw new ConnectorError("Generic REST connector baseUrl cannot contain credentials.");
  }

  if (url.search || url.hash) {
    throw new ConnectorError("Generic REST connector baseUrl cannot contain query or fragment data.");
  }

  if (url.pathname !== "/" && url.pathname !== "") {
    throw new ConnectorError(
      "Generic REST connector baseUrl must be an origin; put API prefixes in endpoint paths.",
    );
  }

  return url;
}

function buildRequestUrl(
  baseUrl: URL,
  endpoint: GenericRestEndpointDefinition,
  input: unknown,
): URL {
  const renderedPath = endpoint.request.path.replace(
    /\{([A-Za-z0-9_.-]+)\}/g,
    (_match, fieldPath: string) => {
      const value = requireScalarInput(input, fieldPath, `path ${fieldPath}`);
      return encodeURIComponent(String(value));
    },
  );

  const url = new URL(baseUrl.toString());
  url.pathname = renderedPath;

  for (const [name, fieldPath] of Object.entries(endpoint.request.query ?? {})) {
    const value = readPath(input, fieldPath);
    appendQueryValue(url, name, value, endpoint.id);
  }

  return url;
}

function buildRequestBody(
  endpoint: GenericRestEndpointDefinition,
  input: unknown,
): string | undefined {
  const path = endpoint.request.bodyInputPath;
  if (path === undefined) {
    return undefined;
  }

  const value = path === "$" ? input : readPath(input, path);
  if (value === undefined) {
    throw new ConnectorError(
      `Generic REST endpoint ${endpoint.id} request body source is missing: ${path}`,
    );
  }

  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new Error("value is not JSON serializable");
    }
    return serialized;
  } catch (error) {
    throw new ConnectorError(
      `Generic REST endpoint ${endpoint.id} request body is not JSON serializable.`,
      { cause: error },
    );
  }
}

function buildStaticHeaders(
  defaults: Readonly<Record<string, string>> | undefined,
  endpointHeaders: Readonly<Record<string, string>> | undefined,
): Headers {
  const headers = new Headers();

  for (const source of [defaults, endpointHeaders]) {
    for (const [name, value] of Object.entries(source ?? {})) {
      headers.set(name, value);
    }
  }

  return headers;
}

async function applyAuth(
  auth: GenericRestAuth,
  url: URL,
  headers: Headers,
  context: ConnectorToolExecutionContext,
  sensitiveValues: string[],
): Promise<void> {
  switch (auth.type) {
    case "none":
      return;
    case "bearer": {
      const token = await requireConnectorSecret(
        context.secrets,
        auth.requirementId,
        auth.tokenField,
      );
      sensitiveValues.push(token);
      headers.set("authorization", `Bearer ${token}`);
      return;
    }
    case "api_key": {
      const value = await requireConnectorSecret(
        context.secrets,
        auth.requirementId,
        auth.fieldId,
      );
      sensitiveValues.push(value);
      if (auth.location === "header") {
        headers.set(auth.name, value);
      } else {
        url.searchParams.set(auth.name, value);
      }
      return;
    }
    case "basic": {
      const username = await requireConnectorSecret(
        context.secrets,
        auth.requirementId,
        auth.usernameField,
      );
      const password = await requireConnectorSecret(
        context.secrets,
        auth.requirementId,
        auth.passwordField,
      );
      sensitiveValues.push(username, password);
      const encoded = Buffer.from(`${username}:${password}`, "utf8").toString("base64");
      headers.set("authorization", `Basic ${encoded}`);
      return;
    }
  }
}

function validateAuth(auth: GenericRestAuth | undefined, label: string): void {
  if (!auth || auth.type === "none") return;

  if (!auth.requirementId.trim()) {
    throw new Error(`Generic REST ${label} auth requirementId is required.`);
  }

  if (auth.type === "bearer" && !auth.tokenField.trim()) {
    throw new Error(`Generic REST ${label} bearer tokenField is required.`);
  }

  if (auth.type === "api_key") {
    if (!auth.fieldId.trim() || !auth.name.trim() || /[\r\n]/.test(auth.name)) {
      throw new Error(`Generic REST ${label} API key mapping is invalid.`);
    }
    if (auth.location === "header") validateHeaderName(auth.name, true);
  }

  if (
    auth.type === "basic" &&
    (!auth.usernameField.trim() || !auth.passwordField.trim())
  ) {
    throw new Error(`Generic REST ${label} basic auth field mapping is invalid.`);
  }
}

function validateStaticHeaders(
  headers: Readonly<Record<string, string>> | undefined,
  label: string,
): void {
  for (const [name, value] of Object.entries(headers ?? {})) {
    validateHeaderName(name, false);
    if (/\r|\n/.test(value)) {
      throw new Error(`Generic REST ${label} header ${name} contains a newline.`);
    }
  }
}

function validateHeaderName(name: string, allowSensitive: boolean): void {
  const normalized = name.trim().toLowerCase();
  if (!normalized || /[\s\r\n:]/.test(normalized)) {
    throw new Error(`Generic REST header name is invalid: ${name}`);
  }
  if (FORBIDDEN_TRANSPORT_HEADERS.has(normalized)) {
    throw new Error(`Generic REST header is transport-controlled: ${name}`);
  }
  if (!allowSensitive && SENSITIVE_HEADER_PATTERN.test(normalized)) {
    throw new Error(
      `Generic REST sensitive header ${name} must be provided through auth/SecretProvider.`,
    );
  }
}

function appendQueryValue(
  url: URL,
  name: string,
  value: unknown,
  endpointId: string,
): void {
  if (value === null || value === undefined) return;

  if (Array.isArray(value)) {
    for (const entry of value) {
      appendQueryValue(url, name, entry, endpointId);
    }
    return;
  }

  if (
    typeof value !== "string" &&
    typeof value !== "number" &&
    typeof value !== "boolean"
  ) {
    throw new ConnectorError(
      `Generic REST endpoint ${endpointId} query value ${name} must be scalar or an array of scalars.`,
    );
  }

  url.searchParams.append(name, String(value));
}

function requireScalarInput(
  input: unknown,
  path: string,
  label: string,
): string | number | boolean {
  const value = readPath(input, path);
  if (
    typeof value !== "string" &&
    typeof value !== "number" &&
    typeof value !== "boolean"
  ) {
    throw new ConnectorError(`Generic REST ${label} must resolve to a scalar value.`);
  }
  return value;
}

function readPath(value: unknown, path: string): unknown {
  let current = value;

  for (const segment of path.split(".")) {
    if (
      current === null ||
      typeof current !== "object" ||
      Array.isArray(current) ||
      !Object.prototype.hasOwnProperty.call(current, segment)
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
  endpointId: string,
): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength) {
    const parsed = Number(declaredLength);
    if (Number.isFinite(parsed) && parsed > maxBytes) {
      await discardResponseBody(response);
      throw new ConnectorError(
        `Generic REST endpoint ${endpointId} response exceeds ${maxBytes} bytes.`,
      );
    }
  }

  const raw = new Uint8Array(await response.arrayBuffer());
  if (raw.byteLength > maxBytes) {
    throw new ConnectorError(
      `Generic REST endpoint ${endpointId} response exceeds ${maxBytes} bytes.`,
    );
  }
  return raw;
}

function validateMaxBytes(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > ABSOLUTE_MAX_RESPONSE_BYTES) {
    throw new Error(
      `Generic REST response maxBytes must be between 1 and ${ABSOLUTE_MAX_RESPONSE_BYTES}.`,
    );
  }
  return value;
}

function assertJsonContentType(response: Response, endpointId: string): void {
  const contentType = response.headers.get("content-type");
  if (!contentType) return;

  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (mediaType !== "application/json" && !mediaType.endsWith("+json")) {
    throw new ConnectorError(
      `Generic REST endpoint ${endpointId} returned non-JSON content type ${mediaType}.`,
    );
  }
}

function isTransientStatus(status: number): boolean {
  return [408, 425, 429, 500, 502, 503, 504].includes(status);
}

async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Best-effort cleanup only; never replace the original HTTP error.
  }
}

function redactJson(
  value: unknown,
  sensitiveValues: readonly string[],
  extraKeys: readonly string[],
  depth = 0,
): unknown {
  if (depth > 32) return "[TRUNCATED]";

  if (typeof value === "string") {
    return redactText(value, sensitiveValues);
  }

  if (Array.isArray(value)) {
    return value.map((entry) =>
      redactJson(entry, sensitiveValues, extraKeys, depth + 1),
    );
  }

  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(key, extraKeys)) {
        result[key] = REDACTED;
      } else {
        result[key] = redactJson(child, sensitiveValues, extraKeys, depth + 1);
      }
    }
    return result;
  }

  return value;
}

function redactText(value: string, sensitiveValues: readonly string[]): string {
  let result = value.replace(
    /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
    `Bearer ${REDACTED}`,
  );

  for (const sensitive of sensitiveValues) {
    if (!sensitive) continue;
    result = result.split(sensitive).join(REDACTED);
  }

  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(result)) {
    return REDACTED;
  }

  return result;
}

function isSensitiveKey(key: string, extraKeys: readonly string[]): boolean {
  const normalized = normalizeKey(key);
  const defaults = DEFAULT_SENSITIVE_KEYS.map(normalizeKey);
  const extras = extraKeys.map(normalizeKey);
  return [...defaults, ...extras].some(
    (candidate) => normalized === candidate || normalized.includes(candidate),
  );
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

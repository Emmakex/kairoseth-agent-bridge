import { randomUUID } from "node:crypto";

import type { A2ATaskState } from "./execution-contracts.js";
import {
  sameA2ATaskScope,
  type A2AStoredTask,
  type A2ATaskScope,
  type A2ATaskStore,
  type A2ATaskTransitionClaim,
} from "./task-store.js";

const DEFAULT_SAVE_PATH = "/api/products/agent-bridge/a2a/tasks/save";
const DEFAULT_GET_PATH = "/api/products/agent-bridge/a2a/tasks/get";
const DEFAULT_CLAIM_PATH = "/api/products/agent-bridge/a2a/tasks/claim";
const DEFAULT_COMPLETE_PATH = "/api/products/agent-bridge/a2a/tasks/complete";
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export type PlatformA2AAccessTokenProvider = () => string | Promise<string>;

export interface PlatformA2ATaskStoreOptions {
  baseUrl: string;
  accessToken: PlatformA2AAccessTokenProvider;
  fetch?: typeof globalThis.fetch | undefined;
  savePath?: string | undefined;
  getPath?: string | undefined;
  claimPath?: string | undefined;
  completePath?: string | undefined;
  allowInsecureHttp?: boolean | undefined;
}

export class PlatformA2ATaskStoreError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly code: string,
  ) {
    super(message);
    this.name = "PlatformA2ATaskStoreError";
  }
}

/**
 * Shared/cluster-safe A2A task store backed by the authoritative Kairoseth
 * Platform control plane. The Platform endpoints must implement save/get and
 * claim/complete atomically for one task ID across every runtime instance.
 *
 * This client never falls back to local or in-memory state. Transport failure,
 * malformed responses, scope mismatches and uncertain completion all fail
 * closed so a mutating resume is never replayed automatically.
 */
export class PlatformA2ATaskStore implements A2ATaskStore {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly accessToken: PlatformA2AAccessTokenProvider;
  private readonly saveUrl: URL;
  private readonly getUrl: URL;
  private readonly claimUrl: URL;
  private readonly completeUrl: URL;

  constructor(options: PlatformA2ATaskStoreOptions) {
    const baseUrl = normalizedBaseUrl(
      options.baseUrl,
      options.allowInsecureHttp ?? false,
    );
    if (typeof options.accessToken !== "function") {
      throw new Error("Platform A2A task store accessToken provider is required.");
    }

    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.accessToken = options.accessToken;
    this.saveUrl = endpoint(baseUrl, options.savePath ?? DEFAULT_SAVE_PATH);
    this.getUrl = endpoint(baseUrl, options.getPath ?? DEFAULT_GET_PATH);
    this.claimUrl = endpoint(baseUrl, options.claimPath ?? DEFAULT_CLAIM_PATH);
    this.completeUrl = endpoint(
      baseUrl,
      options.completePath ?? DEFAULT_COMPLETE_PATH,
    );
  }

  async save(record: A2AStoredTask): Promise<void> {
    validateRecordShape(record);
    await this.request(this.saveUrl, {
      version: "kab.a2a-task-save.v1",
      record: structuredClone(record),
    });
  }

  async get(
    taskId: string,
    scope: A2ATaskScope,
  ): Promise<A2AStoredTask | null> {
    validateIdentifier(taskId, "task ID");
    validateScope(scope);

    const payload = await this.request(this.getUrl, {
      version: "kab.a2a-task-get.v1",
      taskId,
      scope: structuredClone(scope),
    });
    if (!isPlainObject(payload) || !("record" in payload)) {
      throw invalidResponse("get");
    }
    if (payload.record === null) return null;
    if (!isStoredTask(payload.record)) throw invalidResponse("get");
    if (
      payload.record.task.id !== taskId ||
      !sameA2ATaskScope(payload.record.scope, scope)
    ) {
      throw invalidResponse("get_scope_mismatch");
    }
    return structuredClone(payload.record);
  }

  async claimTransition(
    taskId: string,
    scope: A2ATaskScope,
    expectedState: A2ATaskState,
    expectedActionFingerprint: string,
    claimId: string = randomUUID(),
  ): Promise<A2ATaskTransitionClaim | null> {
    validateIdentifier(taskId, "task ID");
    validateScope(scope);
    validateIdentifier(expectedState, "expected state");
    validateFingerprint(expectedActionFingerprint);
    validateIdentifier(claimId, "claim ID");

    const payload = await this.request(this.claimUrl, {
      version: "kab.a2a-task-claim.v1",
      taskId,
      scope: structuredClone(scope),
      expectedState,
      expectedActionFingerprint,
      claimId,
    });
    if (!isPlainObject(payload) || !("claim" in payload)) {
      throw invalidResponse("claim");
    }
    if (payload.claim === null) return null;
    if (!isTransitionClaim(payload.claim)) throw invalidResponse("claim");
    if (
      payload.claim.claimId !== claimId ||
      payload.claim.record.task.id !== taskId ||
      payload.claim.record.task.status.state !== expectedState ||
      payload.claim.record.invocation.actionFingerprint !==
        expectedActionFingerprint ||
      !sameA2ATaskScope(payload.claim.record.scope, scope)
    ) {
      throw invalidResponse("claim_binding_mismatch");
    }
    return structuredClone(payload.claim);
  }

  async completeTransition(
    claim: A2ATaskTransitionClaim,
    record: A2AStoredTask,
  ): Promise<boolean> {
    if (!isTransitionClaim(claim)) {
      throw new Error("Platform A2A task store transition claim is invalid.");
    }
    validateRecordShape(record);
    if (
      record.task.id !== claim.record.task.id ||
      !sameA2ATaskScope(record.scope, claim.record.scope)
    ) {
      throw new Error("Platform A2A task store transition completion mismatch.");
    }

    const payload = await this.request(this.completeUrl, {
      version: "kab.a2a-task-complete.v1",
      claim: structuredClone(claim),
      record: structuredClone(record),
    });
    if (
      !isPlainObject(payload) ||
      typeof payload.completed !== "boolean"
    ) {
      throw invalidResponse("complete");
    }
    return payload.completed;
  }

  private async request(url: URL, body: unknown): Promise<unknown> {
    const token = requireCredential(await this.accessToken());
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          "Cache-Control": "no-store",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        redirect: "error",
        cache: "no-store",
      });
    } catch {
      throw new PlatformA2ATaskStoreError(
        "Kairoseth Platform A2A task store request failed.",
        null,
        "platform_a2a_transport_failed",
      );
    }

    const payload = await boundedJson(response);
    if (!response.ok) {
      throw new PlatformA2ATaskStoreError(
        "Kairoseth Platform rejected the A2A task store request.",
        response.status,
        responseCode(payload),
      );
    }
    return payload;
  }
}

function normalizedBaseUrl(value: string, allowInsecureHttp: boolean): URL {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      "Platform A2A task store base URL must not contain credentials, query, or fragment.",
    );
  }
  const localHost =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1";
  if (url.protocol !== "https:" && !(allowInsecureHttp || localHost)) {
    throw new Error("Platform A2A task store requires HTTPS outside local development.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Platform A2A task store only supports HTTP(S) URLs.");
  }
  return url;
}

function endpoint(baseUrl: URL, path: string): URL {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new Error("Platform A2A task store endpoint paths must be absolute paths.");
  }
  const url = new URL(path, baseUrl);
  if (url.origin !== baseUrl.origin || url.search || url.hash) {
    throw new Error("Platform A2A task store endpoint must remain on the Platform origin.");
  }
  return url;
}

function requireCredential(value: string): string {
  if (typeof value !== "string") {
    throw new Error("Platform A2A task store access token is required.");
  }
  const token = value.trim();
  if (!token || /[\u0000-\u001f\u007f]/.test(token)) {
    throw new Error("Platform A2A task store access token is invalid.");
  }
  return token;
}

async function boundedJson(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength) {
    const parsedLength = Number(declaredLength);
    if (Number.isFinite(parsedLength) && parsedLength > MAX_RESPONSE_BYTES) {
      throw invalidResponse("response_too_large", response.status);
    }
  }

  let text: string;
  try {
    text = await response.text();
  } catch {
    throw invalidResponse("response_unreadable", response.status);
  }
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
    throw invalidResponse("response_too_large", response.status);
  }
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw invalidResponse("invalid_json", response.status);
  }
}

function responseCode(payload: unknown): string {
  if (
    isPlainObject(payload) &&
    typeof payload.code === "string" &&
    /^[A-Za-z0-9_.-]{1,96}$/.test(payload.code.trim())
  ) {
    return payload.code.trim();
  }
  return "platform_a2a_request_failed";
}

function invalidResponse(
  suffix: string,
  status: number | null = null,
): PlatformA2ATaskStoreError {
  return new PlatformA2ATaskStoreError(
    "Kairoseth Platform returned an invalid A2A task store response.",
    status,
    `invalid_platform_a2a_${suffix}_response`,
  );
}

function validateIdentifier(value: string, label: string): void {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 512 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`Platform A2A task store ${label} is invalid.`);
  }
}

function validateFingerprint(value: string): void {
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error("Platform A2A task store action fingerprint is invalid.");
  }
}

function validateScope(scope: A2ATaskScope): void {
  validateIdentifier(scope.actor, "actor");
  validateIdentifier(scope.tenantId, "tenant ID");
  validateIdentifier(scope.installationId, "installation ID");
}

function validateRecordShape(record: A2AStoredTask): void {
  if (!isStoredTask(record)) {
    throw new Error("Platform A2A task store record is invalid.");
  }
}

function isStoredTask(value: unknown): value is A2AStoredTask {
  if (!isPlainObject(value)) return false;
  const task = value.task;
  const scope = value.scope;
  const invocation = value.invocation;
  return (
    isPlainObject(task) &&
    typeof task.id === "string" &&
    task.id.length > 0 &&
    isPlainObject(task.status) &&
    typeof task.status.state === "string" &&
    isPlainObject(scope) &&
    typeof scope.actor === "string" &&
    typeof scope.tenantId === "string" &&
    typeof scope.installationId === "string" &&
    isPlainObject(invocation) &&
    typeof invocation.toolId === "string" &&
    typeof invocation.correlationId === "string" &&
    typeof invocation.actionFingerprint === "string" &&
    Object.prototype.hasOwnProperty.call(invocation, "input")
  );
}

function isTransitionClaim(value: unknown): value is A2ATaskTransitionClaim {
  return (
    isPlainObject(value) &&
    typeof value.claimId === "string" &&
    value.claimId.length > 0 &&
    isStoredTask(value.record)
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

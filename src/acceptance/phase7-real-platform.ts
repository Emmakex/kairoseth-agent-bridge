import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { defaultGenericRestHttpRuntime } from "../connectors/generic-rest/network.js";
import type { ConnectorInstance } from "../connectors/sdk/contracts.js";
import { connectorRuntimeToolId } from "../connectors/sdk/validation.js";
import { createWooCommerceConnector } from "../connectors/woocommerce/connector.js";
import type { InstallationBinding } from "../control-channel/enrollment.js";
import type { PublicBridgeIdentity } from "../identity/installation-identity.js";
import {
  ProductionRuntime,
  type ProductionRuntimeRecoverableSource,
} from "../runtime/production-runtime.js";

const ORDER_STATUSES = new Set([
  "pending",
  "processing",
  "on-hold",
  "completed",
  "cancelled",
  "refunded",
  "failed",
]);
const READ_TOOL_ID = connectorRuntimeToolId("woocommerce", "store", "orders.get");
const WRITE_TOOL_ID = connectorRuntimeToolId(
  "woocommerce",
  "store",
  "orders.update-status",
);
const DEFAULT_TIMEOUT_MS = 90_000;
const MAX_SECRET_FILE_BYTES = 16_384;
const MAX_STATE_SCAN_BYTES = 8 * 1024 * 1024;

export interface Phase7RealPlatformAcceptanceConfig {
  platformBaseUrl: string;
  stateDir: string;
  runtimeVersion: string;
  artifactSha256?: string | undefined;
  operatorToken: string;
  wooCommerceBaseUrl: string;
  wooCommerceConsumerKey: string;
  wooCommerceConsumerSecret: string;
  wooCommerceOrderId: number;
  expectedOrderStatus: string;
  targetOrderStatus: string;
  allowPrivateWooCommerceNetwork: boolean;
  allowInsecurePlatformHttp: boolean;
  timeoutMs: number;
  evidencePath?: string | undefined;
}

interface RuntimeObservation {
  connectivity: "connected";
  readiness: "ready" | "degraded";
  runtimeVersion: string;
  deploymentMode: string;
  connectorCount: number;
  toolCount: number;
}

export interface Phase7RealPlatformAcceptanceEvidence {
  version: "kab.phase7-real-platform-acceptance.v1";
  result: "passed";
  startedAt: string;
  completedAt: string;
  runtimeVersion: string;
  artifactSha256?: string | undefined;
  platformOrigin: string;
  installationId: string;
  bridgeInstanceId: string;
  read: {
    correlationId: string;
    commandId: string;
    status: "executed";
    deliveryAttempt: 1;
    expectedOrderStatusMatched: true;
  };
  write: {
    correlationId: string;
    commandId: string;
    status: "executed";
    deliveryAttempt: 1;
    targetOrderStatusMatched: true;
  };
  restart: {
    identityPreserved: true;
    bindingPreserved: true;
    completedCommandsNotRedelivered: true;
  };
  observability: {
    beforeRestart: RuntimeObservation;
    afterRestart: RuntimeObservation;
  };
  auditOutboxDrained: true;
  durableStateSecretScan: "passed";
  duplicateSafetyProof: {
    realPlatformBoundary: "completed_commands_not_redelivered";
    crashRedeliveryBoundary: "tests/acceptance/phase7-woocommerce-real-flow.test.ts";
  };
  recoverableSources: ProductionRuntimeRecoverableSource[];
}

interface RuntimeFacade {
  publicIdentity(): Promise<PublicBridgeIdentity>;
  enrollment(): Promise<InstallationBinding | null>;
  enroll(token: string): Promise<InstallationBinding>;
  run(signal?: AbortSignal): Promise<void>;
}

interface CommandProjection {
  commandId: string;
  correlationId: string;
  state: "queued" | "delivered" | "completed";
  deliveryAttempt: number;
  acknowledgement?: { status?: string; output?: unknown } | undefined;
}

export interface Phase7RealPlatformAcceptanceDependencies {
  fetch?: typeof globalThis.fetch | undefined;
  runtimeFactory?:
    | ((input: {
        config: Phase7RealPlatformAcceptanceConfig;
        onRecoverableError: (
          source: ProductionRuntimeRecoverableSource,
          retryDelayMs: number,
        ) => void;
      }) => RuntimeFacade)
    | undefined;
  now?: (() => Date) | undefined;
  sleep?: ((milliseconds: number) => Promise<void>) | undefined;
}

export async function loadPhase7RealPlatformAcceptanceConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<Phase7RealPlatformAcceptanceConfig> {
  rejectDirectSecretEnv(env, "KAB_ACCEPTANCE_OPERATOR_TOKEN");
  rejectDirectSecretEnv(env, "KAB_ACCEPTANCE_WC_CONSUMER_KEY");
  rejectDirectSecretEnv(env, "KAB_ACCEPTANCE_WC_CONSUMER_SECRET");

  const allowInsecurePlatformHttp = parseBoolean(
    env.KAB_ACCEPTANCE_ALLOW_INSECURE_PLATFORM_HTTP,
    false,
  );
  const platformBaseUrl = normalizedBaseUrl(
    requiredEnv(env, "KAB_PLATFORM_BASE_URL"),
    allowInsecurePlatformHttp,
    "KAB_PLATFORM_BASE_URL",
  );
  const stateDir = resolve(requiredEnv(env, "KAB_STATE_DIR"));
  if (stateDir === "/") throw new Error("KAB_STATE_DIR must not be the filesystem root.");

  const runtimeVersion = requiredEnv(env, "KAB_ACCEPTANCE_RUNTIME_VERSION");
  const artifactSha256 = optionalArtifactSha256(env.KAB_ACCEPTANCE_ARTIFACT_SHA256);
  const wooCommerceBaseUrl = normalizedWooCommerceBaseUrl(
    requiredEnv(env, "KAB_ACCEPTANCE_WC_BASE_URL"),
  );
  const wooCommerceOrderId = positiveInteger(
    requiredEnv(env, "KAB_ACCEPTANCE_WC_ORDER_ID"),
    "KAB_ACCEPTANCE_WC_ORDER_ID",
  );
  const expectedOrderStatus = orderStatus(
    requiredEnv(env, "KAB_ACCEPTANCE_WC_EXPECTED_STATUS"),
    "KAB_ACCEPTANCE_WC_EXPECTED_STATUS",
  );
  const targetOrderStatus = orderStatus(
    requiredEnv(env, "KAB_ACCEPTANCE_WC_TARGET_STATUS"),
    "KAB_ACCEPTANCE_WC_TARGET_STATUS",
  );
  if (expectedOrderStatus === targetOrderStatus) {
    throw new Error("The expected and target WooCommerce order statuses must differ.");
  }

  const timeoutMs = env.KAB_ACCEPTANCE_TIMEOUT_MS
    ? positiveInteger(env.KAB_ACCEPTANCE_TIMEOUT_MS, "KAB_ACCEPTANCE_TIMEOUT_MS")
    : DEFAULT_TIMEOUT_MS;
  if (timeoutMs < 10_000 || timeoutMs > 600_000) {
    throw new Error("KAB_ACCEPTANCE_TIMEOUT_MS must be between 10000 and 600000.");
  }

  const operatorToken = await readSecretFile(
    requiredEnv(env, "KAB_ACCEPTANCE_OPERATOR_TOKEN_FILE"),
    "operator token",
  );
  const wooCommerceConsumerKey = await readSecretFile(
    requiredEnv(env, "KAB_ACCEPTANCE_WC_CONSUMER_KEY_FILE"),
    "WooCommerce consumer key",
  );
  const wooCommerceConsumerSecret = await readSecretFile(
    requiredEnv(env, "KAB_ACCEPTANCE_WC_CONSUMER_SECRET_FILE"),
    "WooCommerce consumer secret",
  );
  const evidencePath = env.KAB_ACCEPTANCE_EVIDENCE_PATH?.trim()
    ? resolve(env.KAB_ACCEPTANCE_EVIDENCE_PATH.trim())
    : undefined;

  return {
    platformBaseUrl,
    stateDir,
    runtimeVersion,
    ...(artifactSha256 ? { artifactSha256 } : {}),
    operatorToken,
    wooCommerceBaseUrl,
    wooCommerceConsumerKey,
    wooCommerceConsumerSecret,
    wooCommerceOrderId,
    expectedOrderStatus,
    targetOrderStatus,
    allowPrivateWooCommerceNetwork: parseBoolean(
      env.KAB_ACCEPTANCE_ALLOW_PRIVATE_WC_NETWORK,
      false,
    ),
    allowInsecurePlatformHttp,
    timeoutMs,
    ...(evidencePath ? { evidencePath } : {}),
  };
}

export async function runPhase7RealPlatformAcceptance(
  config: Phase7RealPlatformAcceptanceConfig,
  dependencies: Phase7RealPlatformAcceptanceDependencies = {},
): Promise<Phase7RealPlatformAcceptanceEvidence> {
  const fetchImpl = dependencies.fetch ?? globalThis.fetch;
  const now = dependencies.now ?? (() => new Date());
  const sleep = dependencies.sleep ?? (async (milliseconds) => await delay(milliseconds));
  const startedAt = now().toISOString();
  const recoverableSources = new Set<ProductionRuntimeRecoverableSource>();
  const operator = new PlatformOperatorClient(
    config.platformBaseUrl,
    config.operatorToken,
    fetchImpl,
  );
  const workspaceId = await operator.activeWorkspaceId();
  const enrollmentToken = await operator.issueEnrollmentToken();
  const runtimeFactory = dependencies.runtimeFactory ?? defaultRuntimeFactory;
  const makeRuntime = (): RuntimeFacade =>
    runtimeFactory({
      config,
      onRecoverableError: (source) => recoverableSources.add(source),
    });

  let runtime = makeRuntime();
  const identityBeforeEnrollment = await runtime.publicIdentity();
  const binding = await runtime.enroll(enrollmentToken);
  if (binding.tenantId !== workspaceId) {
    throw new Error("Platform enrolled the runtime into a different workspace scope.");
  }

  let controller: AbortController | null = null;
  let runPromise: Promise<void> | null = null;
  const startRuntime = (): void => {
    if (controller) throw new Error("Acceptance runtime is already running.");
    controller = new AbortController();
    runPromise = runtime.run(controller.signal);
  };
  const stopRuntime = async (): Promise<void> => {
    if (!controller) return;
    controller.abort();
    await runPromise;
    controller = null;
    runPromise = null;
  };

  try {
    startRuntime();
    const beforeRestart = await waitForObservation(
      operator,
      binding.installationId,
      config.runtimeVersion,
      config.timeoutMs,
      sleep,
    );

    const readCorrelationId = correlationId("read", now());
    const queuedRead = await operator.queueRead(binding.installationId, {
      toolId: READ_TOOL_ID,
      input: { orderId: config.wooCommerceOrderId },
      correlationId: readCorrelationId,
    });
    const completedRead = await waitForCommand(
      operator,
      queuedRead.commandId,
      config.timeoutMs,
      sleep,
    );
    requireExecutedOnce(completedRead, "READ");
    if (orderStatusFromOutput(completedRead.acknowledgement?.output) !== config.expectedOrderStatus) {
      throw new Error(
        "Controlled WooCommerce order no longer matches the explicitly expected pre-mutation status.",
      );
    }

    const writeCorrelationId = correlationId("write", now());
    const queuedWrite = await operator.queueApprovedWrite(binding.installationId, {
      toolId: WRITE_TOOL_ID,
      input: { orderId: config.wooCommerceOrderId, status: config.targetOrderStatus },
      correlationId: writeCorrelationId,
      ttlSeconds: 120,
    });
    const completedWrite = await waitForCommand(
      operator,
      queuedWrite.commandId,
      config.timeoutMs,
      sleep,
    );
    requireExecutedOnce(completedWrite, "WRITE");
    if (orderStatusFromOutput(completedWrite.acknowledgement?.output) !== config.targetOrderStatus) {
      throw new Error("WooCommerce WRITE completed without the expected controlled target status.");
    }

    await waitForAuditOutboxDrain(config.stateDir, config.timeoutMs, sleep);
    await stopRuntime();

    runtime = makeRuntime();
    const identityAfterRestart = await runtime.publicIdentity();
    const bindingAfterRestart = await runtime.enrollment();
    if (!sameJson(identityBeforeEnrollment, identityAfterRestart)) {
      throw new Error("Agent Bridge identity changed across the controlled restart.");
    }
    if (!bindingAfterRestart || !sameJson(binding, bindingAfterRestart)) {
      throw new Error("Agent Bridge installation binding changed across the controlled restart.");
    }

    startRuntime();
    const afterRestart = await waitForObservation(
      operator,
      binding.installationId,
      config.runtimeVersion,
      config.timeoutMs,
      sleep,
    );
    requireExecutedOnce(await operator.getCommand(queuedRead.commandId), "READ after restart");
    requireExecutedOnce(await operator.getCommand(queuedWrite.commandId), "WRITE after restart");
    await waitForAuditOutboxDrain(config.stateDir, config.timeoutMs, sleep);
    await stopRuntime();
    await assertDurableStateContainsNoAcceptanceSecrets(config);

    const evidence: Phase7RealPlatformAcceptanceEvidence = {
      version: "kab.phase7-real-platform-acceptance.v1",
      result: "passed",
      startedAt,
      completedAt: now().toISOString(),
      runtimeVersion: config.runtimeVersion,
      ...(config.artifactSha256 ? { artifactSha256: config.artifactSha256 } : {}),
      platformOrigin: new URL(config.platformBaseUrl).origin,
      installationId: binding.installationId,
      bridgeInstanceId: binding.bridgeInstanceId,
      read: {
        correlationId: readCorrelationId,
        commandId: queuedRead.commandId,
        status: "executed",
        deliveryAttempt: 1,
        expectedOrderStatusMatched: true,
      },
      write: {
        correlationId: writeCorrelationId,
        commandId: queuedWrite.commandId,
        status: "executed",
        deliveryAttempt: 1,
        targetOrderStatusMatched: true,
      },
      restart: {
        identityPreserved: true,
        bindingPreserved: true,
        completedCommandsNotRedelivered: true,
      },
      observability: { beforeRestart, afterRestart },
      auditOutboxDrained: true,
      durableStateSecretScan: "passed",
      duplicateSafetyProof: {
        realPlatformBoundary: "completed_commands_not_redelivered",
        crashRedeliveryBoundary: "tests/acceptance/phase7-woocommerce-real-flow.test.ts",
      },
      recoverableSources: [...recoverableSources].sort(),
    };
    if (config.evidencePath) await writeEvidence(config.evidencePath, evidence);
    return evidence;
  } finally {
    await stopRuntime().catch(() => undefined);
  }
}

function defaultRuntimeFactory(input: {
  config: Phase7RealPlatformAcceptanceConfig;
  onRecoverableError: (
    source: ProductionRuntimeRecoverableSource,
    retryDelayMs: number,
  ) => void;
}): RuntimeFacade {
  const { config } = input;
  const connector: ConnectorInstance = {
    instanceId: "store",
    connector: createWooCommerceConnector(
      {
        allowedOrigins: [new URL(config.wooCommerceBaseUrl).origin],
        allowPrivateNetwork: config.allowPrivateWooCommerceNetwork,
      },
      defaultGenericRestHttpRuntime,
    ),
    config: { baseUrl: config.wooCommerceBaseUrl },
    secrets: {
      async getSecret(requirementId, fieldId) {
        if (requirementId !== "woocommerce_api") return null;
        if (fieldId === "consumer_key") return config.wooCommerceConsumerKey;
        if (fieldId === "consumer_secret") return config.wooCommerceConsumerSecret;
        return null;
      },
    },
  };
  return new ProductionRuntime({
    platformBaseUrl: config.platformBaseUrl,
    stateDir: config.stateDir,
    runtimeVersion: config.runtimeVersion,
    deploymentMode: "local",
    connectorInstances: [connector],
    allowInsecureHttp: config.allowInsecurePlatformHttp,
    onRecoverableError: input.onRecoverableError,
  });
}

class PlatformOperatorClient {
  constructor(
    private readonly baseUrl: string,
    private readonly operatorToken: string,
    private readonly fetchImpl: typeof globalThis.fetch,
  ) {}

  async activeWorkspaceId(): Promise<string> {
    return field(await this.request("GET", "/v1/session"), "activeWorkspaceId");
  }

  async issueEnrollmentToken(): Promise<string> {
    return field(
      await this.request("POST", "/v1/products/agent-bridge/enrollment-tokens"),
      "token",
    );
  }

  async observability(): Promise<Record<string, unknown>> {
    return await this.request("GET", "/v1/products/agent-bridge/runtime-observability");
  }

  async queueRead(installationId: string, body: Record<string, unknown>): Promise<CommandProjection> {
    return commandFromResponse(
      await this.request(
        "POST",
        `/v1/products/agent-bridge/installations/${encodeURIComponent(installationId)}/commands`,
        body,
      ),
    );
  }

  async queueApprovedWrite(
    installationId: string,
    body: Record<string, unknown>,
  ): Promise<CommandProjection> {
    return commandFromResponse(
      await this.request(
        "POST",
        `/v1/products/agent-bridge/installations/${encodeURIComponent(installationId)}/approved-commands`,
        body,
      ),
    );
  }

  async getCommand(commandId: string): Promise<CommandProjection> {
    return commandFromResponse(
      await this.request(
        "GET",
        `/v1/products/agent-bridge/commands/${encodeURIComponent(commandId)}`,
      ),
    );
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    payload?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(new URL(path, this.baseUrl), {
      method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${this.operatorToken}`,
        ...(payload ? { "Content-Type": "application/json" } : {}),
      },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
      redirect: "error",
      cache: "no-store",
    });
    const body = await safeJson(response);
    if (!response.ok) {
      const code = body && typeof body.code === "string" ? body.code : "platform_request_failed";
      throw new Error(
        `Platform ${method} ${path} failed (${response.status}/${safeCode(code)}).`,
      );
    }
    if (!body) throw new Error(`Platform ${method} ${path} returned invalid JSON.`);
    return body;
  }
}

async function waitForObservation(
  operator: PlatformOperatorClient,
  installationId: string,
  runtimeVersion: string,
  timeoutMs: number,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<RuntimeObservation> {
  return await poll(
    async () => {
      const summary = record((await operator.observability()).summary);
      const installations = Array.isArray(summary?.installations) ? summary.installations : [];
      const installation = installations
        .map(record)
        .find((candidate) => candidate?.installationId === installationId);
      if (!installation || installation.connectivity !== "connected") return null;
      if (installation.runtimeVersion !== runtimeVersion) return null;
      if (installation.readiness !== "ready" && installation.readiness !== "degraded") return null;
      const connectorCount = numberField(record(installation.connectors), "total");
      const toolCount = numberField(record(installation.tools), "total");
      if (connectorCount < 1 || toolCount < 1) return null;
      return {
        connectivity: "connected" as const,
        readiness: installation.readiness,
        runtimeVersion,
        deploymentMode: String(installation.deploymentMode ?? "unknown"),
        connectorCount,
        toolCount,
      };
    },
    timeoutMs,
    sleep,
    "Platform did not expose the enrolled Agent Bridge runtime with connector/tool inventory.",
  );
}

async function waitForCommand(
  operator: PlatformOperatorClient,
  commandId: string,
  timeoutMs: number,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<CommandProjection> {
  return await poll(
    async () => {
      const command = await operator.getCommand(commandId);
      return command.state === "completed" ? command : null;
    },
    timeoutMs,
    sleep,
    "Agent Bridge command did not complete within the acceptance timeout.",
  );
}

async function waitForAuditOutboxDrain(
  stateDir: string,
  timeoutMs: number,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<void> {
  await poll(
    async () => {
      try {
        const value = JSON.parse(
          await readFile(resolve(stateDir, "audit", "outbox.json"), "utf8"),
        ) as { version?: unknown; events?: unknown };
        return value.version === "kab.audit-outbox.v1" &&
          Array.isArray(value.events) &&
          value.events.length === 0
          ? true
          : null;
      } catch {
        return null;
      }
    },
    timeoutMs,
    sleep,
    "Agent Bridge audit outbox did not drain to Kairoseth Platform.",
  );
}

function requireExecutedOnce(command: CommandProjection, label: string): void {
  if (
    command.state !== "completed" ||
    command.deliveryAttempt !== 1 ||
    command.acknowledgement?.status !== "executed"
  ) {
    throw new Error(`${label} did not complete exactly once with an executed acknowledgement.`);
  }
}

function orderStatusFromOutput(output: unknown): string | null {
  const status = record(output)?.status;
  return typeof status === "string" && ORDER_STATUSES.has(status) ? status : null;
}

function commandFromResponse(body: Record<string, unknown>): CommandProjection {
  const command = record(body.command);
  if (!command) throw new Error("Platform command response is missing the command projection.");
  const state = command.state;
  if (state !== "queued" && state !== "delivered" && state !== "completed") {
    throw new Error("Platform command response contains an invalid command state.");
  }
  const deliveryAttempt = command.deliveryAttempt;
  if (!Number.isInteger(deliveryAttempt) || Number(deliveryAttempt) < 0) {
    throw new Error("Platform command response contains an invalid delivery attempt.");
  }
  const acknowledgement = record(command.acknowledgement);
  return {
    commandId: field(command, "commandId"),
    correlationId: field(command, "correlationId"),
    state,
    deliveryAttempt: Number(deliveryAttempt),
    ...(acknowledgement
      ? {
          acknowledgement: {
            ...(typeof acknowledgement.status === "string"
              ? { status: acknowledgement.status }
              : {}),
            ...(Object.prototype.hasOwnProperty.call(acknowledgement, "output")
              ? { output: acknowledgement.output }
              : {}),
          },
        }
      : {}),
  };
}

async function assertDurableStateContainsNoAcceptanceSecrets(
  config: Phase7RealPlatformAcceptanceConfig,
): Promise<void> {
  let scannedBytes = 0;
  for (const file of await listFiles(config.stateDir)) {
    const metadata = await stat(file);
    scannedBytes += metadata.size;
    if (scannedBytes > MAX_STATE_SCAN_BYTES) {
      throw new Error("Durable state exceeds the bounded Phase 7 secret-scan size.");
    }
    const raw = await readFile(file, "utf8").catch(() => "");
    if (
      raw.includes(config.operatorToken) ||
      raw.includes(config.wooCommerceConsumerKey) ||
      raw.includes(config.wooCommerceConsumerSecret) ||
      /kab1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(raw) ||
      /"(?:accessToken|approvalToken)"\s*:/.test(raw)
    ) {
      throw new Error("Durable Agent Bridge state contains acceptance credential material.");
    }
  }
}

async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}

async function writeEvidence(
  path: string,
  evidence: Phase7RealPlatformAcceptanceEvidence,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

async function readSecretFile(pathValue: string, label: string): Promise<string> {
  const path = resolve(pathValue);
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error(`The ${label} path must reference a regular file.`);
  if (metadata.size > MAX_SECRET_FILE_BYTES) throw new Error(`The ${label} file is unexpectedly large.`);
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    throw new Error(`The ${label} file must not be group/world accessible (use chmod 600).`);
  }
  const value = (await readFile(path, "utf8")).trim();
  if (!value) throw new Error(`The ${label} file is empty.`);
  return value;
}

function normalizedBaseUrl(value: string, allowInsecureHttp: boolean, name: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must not contain credentials, query, or fragment.`);
  }
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && (local || allowInsecureHttp))) {
    throw new Error(`${name} requires HTTPS outside an explicitly controlled environment.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${name} must use HTTP(S).`);
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.toString();
}

function normalizedWooCommerceBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("KAB_ACCEPTANCE_WC_BASE_URL must use HTTPS.");
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("KAB_ACCEPTANCE_WC_BASE_URL must not contain credentials, query, or fragment.");
  }
  return url.toString();
}

function rejectDirectSecretEnv(env: NodeJS.ProcessEnv, key: string): void {
  if (env[key]?.trim()) {
    throw new Error(`${key} is forbidden; Phase 7 acceptance reads credentials from files only.`);
  }
}

function requiredEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required.`);
  return value;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value?.trim()) return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  throw new Error("Boolean acceptance environment values must be true/false or 1/0.");
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return parsed;
}

function orderStatus(value: string, name: string): string {
  const normalized = value.trim();
  if (!ORDER_STATUSES.has(normalized)) {
    throw new Error(`${name} must be an allowlisted WooCommerce order status.`);
  }
  return normalized;
}

function optionalArtifactSha256(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  const match = /^(?:sha256:)?([a-fA-F0-9]{64})$/.exec(normalized);
  if (!match?.[1]) throw new Error("KAB_ACCEPTANCE_ARTIFACT_SHA256 must be a SHA-256 digest.");
  return `sha256:${match[1].toLowerCase()}`;
}

function correlationId(kind: "read" | "write", now: Date): string {
  return `phase7-real-${kind}-${now.toISOString().replace(/[^0-9]/g, "").slice(0, 17)}`;
}

async function poll<T>(
  operation: () => Promise<T | null>,
  timeoutMs: number,
  sleep: (milliseconds: number) => Promise<void>,
  timeoutMessage: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await operation();
    if (result !== null) return result;
    await sleep(500);
  }
  throw new Error(timeoutMessage);
}

async function safeJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    return record(await response.json());
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function field(value: Record<string, unknown>, name: string): string {
  const candidate = value[name];
  if (typeof candidate !== "string" || !candidate.trim()) {
    throw new Error(`Platform response is missing ${name}.`);
  }
  return candidate;
}

function numberField(value: Record<string, unknown> | null, name: string): number {
  const candidate = value?.[name];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : 0;
}

function safeCode(value: string): string {
  return /^[A-Za-z0-9_.-]{1,96}$/.test(value) ? value : "platform_request_failed";
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

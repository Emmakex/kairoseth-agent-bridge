import type { ToolRegistry } from "../../core/registry.js";
import type { InvocationContext, ToolDefinition } from "../../core/contracts.js";
import {
  ConnectorCredentialRotationError,
  ConnectorCredentialRotationPendingError,
  ConnectorError,
  ConnectorTimeoutError,
  ConnectorTransientError,
} from "./errors.js";
import {
  ConnectorCircuitBreaker,
  connectorCircuitKey,
  type ConnectorCircuitSnapshot,
} from "./circuit-breaker.js";
import type {
  ConnectorCredentialRotationFailureReason,
  ConnectorCredentialRotationNotice,
  ConnectorCredentialRotationResult,
  ConnectorCredentialRotationState,
  ConnectorDefinition,
  ConnectorHealthResult,
  ConnectorHealthStatus,
  ConnectorInstance,
  ConnectorInstanceHealthSnapshot,
  ConnectorRetryPolicy,
  ConnectorToolAvailabilityStatus,
  ConnectorToolDefinition,
  ConnectorToolHealthSnapshot,
  RegisteredConnectorInstance,
} from "./contracts.js";
import {
  connectorRuntimeToolId,
  validateConnectorDefinition,
} from "./validation.js";

export interface ConnectorRegistryAdapterOptions {
  defaultToolTimeoutMs?: number | undefined;
  defaultHealthTimeoutMs?: number | undefined;
  defaultCredentialRotationTimeoutMs?: number | undefined;
  sleep?: ((delayMs: number) => Promise<void>) | undefined;
  /** Set false only when an outer execution layer provides equivalent isolation. */
  circuitBreaker?: ConnectorCircuitBreaker | false | undefined;
}

const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 10_000;
const DEFAULT_CREDENTIAL_ROTATION_TIMEOUT_MS = 10_000;
const MAX_CREDENTIAL_ROTATION_RECEIPTS = 256;
const ROTATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

class CredentialRotationTimeoutMarker extends Error {}

export class ConnectorRegistryAdapter {
  private readonly defaultToolTimeoutMs: number;
  private readonly defaultHealthTimeoutMs: number;
  private readonly defaultCredentialRotationTimeoutMs: number;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly circuitBreaker: ConnectorCircuitBreaker | null;
  private readonly instances = new Map<string, ConnectorInstance>();
  private readonly credentialRotationStates = new Map<
    string,
    ConnectorCredentialRotationState
  >();
  private readonly credentialRotationReceipts = new Map<
    string,
    ConnectorCredentialRotationResult
  >();
  private readonly credentialRotationReceiptOrder: string[] = [];

  constructor(
    private readonly registry: ToolRegistry,
    options: ConnectorRegistryAdapterOptions = {},
  ) {
    this.defaultToolTimeoutMs =
      options.defaultToolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    this.defaultHealthTimeoutMs =
      options.defaultHealthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
    this.defaultCredentialRotationTimeoutMs =
      options.defaultCredentialRotationTimeoutMs ??
      DEFAULT_CREDENTIAL_ROTATION_TIMEOUT_MS;
    this.sleep = options.sleep ?? defaultSleep;
    this.circuitBreaker =
      options.circuitBreaker === false
        ? null
        : options.circuitBreaker ?? new ConnectorCircuitBreaker();

    validateTimeout(this.defaultToolTimeoutMs, "default tool timeout");
    validateTimeout(this.defaultHealthTimeoutMs, "default health timeout");
    validateTimeout(
      this.defaultCredentialRotationTimeoutMs,
      "default credential rotation timeout",
    );
  }

  register(instance: ConnectorInstance): RegisteredConnectorInstance {
    validateConnectorDefinition(instance.connector);
    const { manifest } = instance.connector;
    const registrationKey = connectorInstanceKey(manifest.id, instance.instanceId);

    if (this.instances.has(registrationKey)) {
      throw new Error(
        `Connector instance ${manifest.id}.${instance.instanceId} is already registered.`,
      );
    }

    const runtimeToolIds: string[] = [];

    for (const tool of instance.connector.tools) {
      const runtimeToolId = connectorRuntimeToolId(
        manifest.id,
        instance.instanceId,
        tool.id,
      );

      const idempotencyMode = tool.behavior?.idempotency?.mode ?? "none";
      const bridgeTool: ToolDefinition = {
        id: runtimeToolId,
        name: tool.name,
        description: tool.description,
        ...(tool.localizations ? { localizations: tool.localizations } : {}),
        risk: tool.risk,
        inputSchema: tool.inputSchema,
        ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
        hints: {
          ...(idempotencyMode !== "none" ? { idempotent: true } : {}),
          ...(tool.risk === "CRITICAL" ? { destructive: true } : {}),
          openWorld: true,
        },
        execute: (input, invocation) =>
          this.executeTool(instance, tool, input, invocation),
      };

      this.registry.register(bridgeTool);
      runtimeToolIds.push(runtimeToolId);
    }

    this.instances.set(registrationKey, instance);

    return {
      connectorId: manifest.id,
      instanceId: instance.instanceId,
      toolIds: runtimeToolIds,
    };
  }

  credentialRotationState(
    instance: ConnectorInstance,
  ): ConnectorCredentialRotationState {
    validateConnectorDefinition(instance.connector);
    this.assertRegisteredInstance(instance);
    return (
      this.credentialRotationStates.get(instanceKey(instance)) ?? {
        status: "idle",
      }
    );
  }

  /**
   * Apply a metadata-only rotation notice without ever carrying credential
   * values through the adapter. Execution is fail-closed for the entire
   * connector instance until provider/connector refresh hooks complete.
   */
  async credentialsRotated(
    instance: ConnectorInstance,
    notice: ConnectorCredentialRotationNotice,
  ): Promise<ConnectorCredentialRotationResult> {
    validateConnectorDefinition(instance.connector);
    this.assertRegisteredInstance(instance);
    validateCredentialRotationNotice(instance.connector, notice);

    const key = instanceKey(instance);
    const receiptKey = `${key}:${notice.rotationId}`;
    const existingReceipt = this.credentialRotationReceipts.get(receiptKey);
    if (existingReceipt) return existingReceipt;

    const current = this.credentialRotationStates.get(key);
    if (current?.status === "refreshing") {
      throw new ConnectorCredentialRotationError(
        `Connector instance ${instance.connector.manifest.id}.${instance.instanceId} already has a credential rotation in progress.`,
      );
    }

    this.credentialRotationStates.set(key, rotationState("refreshing", notice));

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const applyPromise = Promise.resolve().then(async () => {
      const providerRefresh = instance.secrets.refreshCredentials
        ? "refreshed"
        : "live";
      if (instance.secrets.refreshCredentials) {
        await instance.secrets.refreshCredentials(notice, {
          connectorId: instance.connector.manifest.id,
          connectorInstanceId: instance.instanceId,
          signal: controller.signal,
        });
      }

      const connectorHook = instance.connector.credentialsRotated
        ? "applied"
        : "not_declared";
      if (instance.connector.credentialsRotated) {
        await instance.connector.credentialsRotated(notice, {
          connectorId: instance.connector.manifest.id,
          connectorInstanceId: instance.instanceId,
          config: instance.config ?? {},
          secrets: instance.secrets,
          signal: controller.signal,
        });
      }

      return { providerRefresh, connectorHook } as const;
    });

    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new CredentialRotationTimeoutMarker());
      }, this.defaultCredentialRotationTimeoutMs);
    });

    try {
      const applied = await Promise.race([applyPromise, timeoutPromise]);
      const result: ConnectorCredentialRotationResult = {
        status: "applied",
        rotationId: notice.rotationId,
        connectorId: instance.connector.manifest.id,
        connectorInstanceId: instance.instanceId,
        requirementId: notice.requirementId,
        fieldIds: [...notice.fieldIds],
        rotatedAt: notice.rotatedAt,
        ...(notice.revision ? { revision: notice.revision } : {}),
        providerRefresh: applied.providerRefresh,
        connectorHook: applied.connectorHook,
        appliedAt: new Date().toISOString(),
      };

      this.credentialRotationStates.delete(key);
      this.rememberCredentialRotationReceipt(receiptKey, result);
      return result;
    } catch (error) {
      const failureReason: ConnectorCredentialRotationFailureReason =
        error instanceof CredentialRotationTimeoutMarker
          ? "timeout"
          : "apply_failed";
      this.credentialRotationStates.set(
        key,
        rotationState("blocked", notice, failureReason),
      );
      throw new ConnectorCredentialRotationError(
        `Credential rotation ${notice.rotationId} could not be applied for connector instance ${instance.connector.manifest.id}.${instance.instanceId} (${failureReason}).`,
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Execute one connector-defined probe with bounded runtime and normalized
   * failure handling. Probe exceptions never escape into an aggregate health
   * collector and their raw messages are intentionally not exposed.
   */
  async health(instance: ConnectorInstance): Promise<ConnectorHealthResult> {
    validateConnectorDefinition(instance.connector);

    const rotation = this.activeCredentialRotationState(instance);
    if (rotation) {
      return {
        status: "unhealthy",
        checkedAt: new Date().toISOString(),
        details: { probe: "credential_rotation" },
      };
    }

    const healthProbe = instance.connector.health;

    if (!healthProbe) {
      return {
        status: "healthy",
        checkedAt: new Date().toISOString(),
        details: { probe: "not_declared" },
      };
    }

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const probePromise: Promise<ConnectorHealthResult> = Promise.resolve()
      .then(
        async () =>
          await healthProbe({
            connectorId: instance.connector.manifest.id,
            connectorInstanceId: instance.instanceId,
            config: instance.config ?? {},
            secrets: instance.secrets,
            signal: controller.signal,
          }),
      )
      .catch(() => ({
        status: "unhealthy",
        checkedAt: new Date().toISOString(),
        details: { probe: "failed" },
      }));

    const timeoutPromise = new Promise<ConnectorHealthResult>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({
          status: "unhealthy",
          checkedAt: new Date().toISOString(),
          details: {
            probe: "timeout",
            timeoutMs: this.defaultHealthTimeoutMs,
          },
        });
      }, this.defaultHealthTimeoutMs);
    });

    try {
      return await Promise.race([probePromise, timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Build an operational snapshot for one connector instance. Health is
   * observational only; execution policy and approval remain authoritative.
   */
  async healthSnapshot(
    instance: ConnectorInstance,
  ): Promise<ConnectorInstanceHealthSnapshot> {
    validateConnectorDefinition(instance.connector);
    const rotation = this.activeCredentialRotationState(instance);
    const probe = await this.health(instance);
    const tools = instance.connector.tools.map((tool) =>
      this.toolHealthSnapshot(instance, tool, rotation),
    );

    return {
      connectorId: instance.connector.manifest.id,
      connectorInstanceId: instance.instanceId,
      status: aggregateHealthStatus(probe.status, tools),
      checkedAt: probe.checkedAt,
      probe,
      tools,
      ...(rotation ? { credentialRotation: rotation } : {}),
    };
  }

  /**
   * Probe every registered connector instance independently and return a
   * deterministic snapshot list. One failed or timed-out probe cannot reject
   * or hide the health of another registered instance.
   */
  async healthRegistered(): Promise<readonly ConnectorInstanceHealthSnapshot[]> {
    const instances = [...this.instances.values()].sort((left, right) => {
      const connectorOrder = left.connector.manifest.id.localeCompare(
        right.connector.manifest.id,
      );
      return connectorOrder !== 0
        ? connectorOrder
        : left.instanceId.localeCompare(right.instanceId);
    });

    return await Promise.all(
      instances.map(async (instance) => await this.healthSnapshot(instance)),
    );
  }

  private toolHealthSnapshot(
    instance: ConnectorInstance,
    tool: ConnectorToolDefinition,
    rotation: ConnectorCredentialRotationState | undefined,
  ): ConnectorToolHealthSnapshot {
    const runtimeToolId = connectorRuntimeToolId(
      instance.connector.manifest.id,
      instance.instanceId,
      tool.id,
    );

    const circuit = this.circuitBreaker?.snapshot(
      connectorCircuitKey(
        instance.connector.manifest.id,
        instance.instanceId,
        tool.id,
      ),
    );

    if (rotation) {
      return {
        toolId: tool.id,
        runtimeToolId,
        availability: "blocked",
        blockedReason: "credential_rotation",
        ...(circuit ? { circuit } : {}),
      };
    }

    if (!circuit) {
      return {
        toolId: tool.id,
        runtimeToolId,
        availability: "available",
      };
    }

    const availability = circuitAvailability(circuit);
    return {
      toolId: tool.id,
      runtimeToolId,
      availability,
      ...(availability === "blocked"
        ? { blockedReason: "circuit_open" as const }
        : {}),
      circuit,
    };
  }

  private async executeTool(
    instance: ConnectorInstance,
    tool: ConnectorToolDefinition,
    input: unknown,
    invocation: InvocationContext,
  ): Promise<unknown> {
    this.assertCredentialExecutionAllowed(instance);

    const timeoutMs = tool.behavior?.timeoutMs ?? this.defaultToolTimeoutMs;
    const retry = normalizeRetry(tool.behavior?.retry);
    const idempotencyKey = deriveIdempotencyKey(tool, input);
    const circuitKey = connectorCircuitKey(
      instance.connector.manifest.id,
      instance.instanceId,
      tool.id,
    );
    this.circuitBreaker?.beforeRequest(circuitKey);
    let attempt = 1;

    while (true) {
      try {
        const output = await this.executeAttempt(
          instance,
          tool,
          input,
          invocation,
          timeoutMs,
          attempt,
          idempotencyKey,
        );
        this.circuitBreaker?.recordSuccess(circuitKey);
        return output;
      } catch (error) {
        const shouldRetry =
          error instanceof ConnectorTransientError &&
          retry.mode === "transient" &&
          attempt < retry.maxAttempts;

        if (shouldRetry) {
          const delayMs = retryDelayMs(retry, attempt);
          await this.sleep(delayMs);
          attempt += 1;
          continue;
        }

        if (error instanceof ConnectorTransientError) {
          this.circuitBreaker?.recordFailure(circuitKey);
        } else {
          // A non-transient/business/configuration response proves the backend
          // path did not fail in the availability sense tracked by the breaker.
          this.circuitBreaker?.recordSuccess(circuitKey);
        }
        throw error;
      }
    }
  }

  private async executeAttempt(
    instance: ConnectorInstance,
    tool: ConnectorToolDefinition,
    input: unknown,
    invocation: InvocationContext,
    timeoutMs: number,
    attempt: number,
    idempotencyKey: string | undefined,
  ): Promise<unknown> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ConnectorTimeoutError(tool.id, timeoutMs));
      }, timeoutMs);
    });

    try {
      return await Promise.race([
        tool.execute(input, {
          invocation,
          connectorId: instance.connector.manifest.id,
          connectorInstanceId: instance.instanceId,
          config: instance.config ?? {},
          secrets: instance.secrets,
          signal: controller.signal,
          attempt,
          idempotencyKey,
        }),
        timeoutPromise,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private assertRegisteredInstance(instance: ConnectorInstance): void {
    const registered = this.instances.get(instanceKey(instance));
    if (registered !== instance) {
      throw new ConnectorCredentialRotationError(
        `Connector instance ${instance.connector.manifest.id}.${instance.instanceId} is not registered in this adapter.`,
      );
    }
  }

  private activeCredentialRotationState(
    instance: ConnectorInstance,
  ): ConnectorCredentialRotationState | undefined {
    return this.credentialRotationStates.get(instanceKey(instance));
  }

  private assertCredentialExecutionAllowed(instance: ConnectorInstance): void {
    if (this.activeCredentialRotationState(instance)) {
      throw new ConnectorCredentialRotationPendingError(
        instance.connector.manifest.id,
        instance.instanceId,
      );
    }
  }

  private rememberCredentialRotationReceipt(
    receiptKey: string,
    result: ConnectorCredentialRotationResult,
  ): void {
    this.credentialRotationReceipts.set(receiptKey, result);
    this.credentialRotationReceiptOrder.push(receiptKey);

    while (
      this.credentialRotationReceiptOrder.length >
      MAX_CREDENTIAL_ROTATION_RECEIPTS
    ) {
      const oldest = this.credentialRotationReceiptOrder.shift();
      if (oldest) this.credentialRotationReceipts.delete(oldest);
    }
  }
}

interface NormalizedRetryPolicy {
  mode: "never" | "transient";
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

function normalizeRetry(
  retry: ConnectorRetryPolicy | undefined,
): NormalizedRetryPolicy {
  if (!retry || retry.mode === "never") {
    return {
      mode: "never",
      maxAttempts: 1,
      baseDelayMs: 0,
      maxDelayMs: 0,
    };
  }

  return {
    mode: "transient",
    maxAttempts: retry.maxAttempts ?? 3,
    baseDelayMs: retry.baseDelayMs ?? 250,
    maxDelayMs: retry.maxDelayMs ?? 5_000,
  };
}

function retryDelayMs(retry: NormalizedRetryPolicy, failedAttempt: number): number {
  return Math.min(
    retry.maxDelayMs,
    retry.baseDelayMs * 2 ** Math.max(0, failedAttempt - 1),
  );
}

function deriveIdempotencyKey(
  tool: ConnectorToolDefinition,
  input: unknown,
): string | undefined {
  const policy = tool.behavior?.idempotency;

  if (!policy || policy.mode !== "keyed") {
    return undefined;
  }

  const path = policy.keyField;
  if (!path) {
    throw new ConnectorError(
      `Connector tool ${tool.id} is missing its keyed idempotency field.`,
    );
  }

  const value = readPath(input, path);

  if (
    value === null ||
    value === undefined ||
    (typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean")
  ) {
    throw new ConnectorError(
      `Connector tool ${tool.id} requires scalar idempotency field: ${path}`,
    );
  }

  const key = String(value).trim();
  if (!key) {
    throw new ConnectorError(
      `Connector tool ${tool.id} requires non-empty idempotency field: ${path}`,
    );
  }

  return key;
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

function circuitAvailability(
  circuit: ConnectorCircuitSnapshot,
): ConnectorToolAvailabilityStatus {
  if (circuit.state === "open") return "blocked";
  if (
    circuit.state === "half-open" ||
    circuit.probeInFlight ||
    circuit.consecutiveFailures > 0
  ) {
    return "degraded";
  }
  return "available";
}

function aggregateHealthStatus(
  probeStatus: ConnectorHealthStatus,
  tools: readonly ConnectorToolHealthSnapshot[],
): ConnectorHealthStatus {
  if (probeStatus === "unhealthy") return "unhealthy";

  const blockedCount = tools.filter(
    (tool) => tool.availability === "blocked",
  ).length;
  if (tools.length > 0 && blockedCount === tools.length) {
    return "unhealthy";
  }

  if (
    probeStatus === "degraded" ||
    tools.some((tool) => tool.availability !== "available")
  ) {
    return "degraded";
  }

  return "healthy";
}

function rotationState(
  status: "refreshing" | "blocked",
  notice: ConnectorCredentialRotationNotice,
  failureReason?: ConnectorCredentialRotationFailureReason,
): ConnectorCredentialRotationState {
  return {
    status,
    rotationId: notice.rotationId,
    requirementId: notice.requirementId,
    fieldIds: [...notice.fieldIds],
    rotatedAt: notice.rotatedAt,
    ...(notice.revision ? { revision: notice.revision } : {}),
    ...(failureReason ? { failureReason } : {}),
  };
}

function validateCredentialRotationNotice(
  connector: ConnectorDefinition,
  notice: ConnectorCredentialRotationNotice,
): void {
  if (!notice || typeof notice !== "object" || Array.isArray(notice)) {
    throw new ConnectorCredentialRotationError(
      "Credential rotation notice must be an object.",
    );
  }

  const allowedKeys = new Set([
    "rotationId",
    "requirementId",
    "fieldIds",
    "rotatedAt",
    "revision",
  ]);
  for (const key of Object.keys(notice as object)) {
    if (!allowedKeys.has(key)) {
      throw new ConnectorCredentialRotationError(
        `Credential rotation notice contains unsupported field: ${key}.`,
      );
    }
  }

  if (!ROTATION_ID_PATTERN.test(notice.rotationId)) {
    throw new ConnectorCredentialRotationError(
      "Credential rotation ID is invalid.",
    );
  }

  const requirement = connector.manifest.credentials.find(
    (candidate) => candidate.id === notice.requirementId,
  );
  if (!requirement) {
    throw new ConnectorCredentialRotationError(
      `Credential rotation references undeclared requirement: ${notice.requirementId}.`,
    );
  }

  if (
    !Array.isArray(notice.fieldIds) ||
    notice.fieldIds.length < 1 ||
    notice.fieldIds.length > 32
  ) {
    throw new ConnectorCredentialRotationError(
      "Credential rotation must reference between 1 and 32 credential fields.",
    );
  }

  const declaredFields = new Set(requirement.fields.map((field) => field.id));
  const seenFields = new Set<string>();
  for (const fieldId of notice.fieldIds) {
    if (typeof fieldId !== "string" || !declaredFields.has(fieldId)) {
      throw new ConnectorCredentialRotationError(
        `Credential rotation references undeclared field: ${String(fieldId)}.`,
      );
    }
    if (seenFields.has(fieldId)) {
      throw new ConnectorCredentialRotationError(
        `Credential rotation contains duplicate field: ${fieldId}.`,
      );
    }
    seenFields.add(fieldId);
  }

  if (
    typeof notice.rotatedAt !== "string" ||
    notice.rotatedAt.length > 64 ||
    Number.isNaN(Date.parse(notice.rotatedAt))
  ) {
    throw new ConnectorCredentialRotationError(
      "Credential rotation rotatedAt is invalid.",
    );
  }

  if (
    notice.revision !== undefined &&
    (typeof notice.revision !== "string" ||
      notice.revision.length < 1 ||
      notice.revision.length > 128 ||
      /[\u0000-\u001f\u007f]/.test(notice.revision))
  ) {
    throw new ConnectorCredentialRotationError(
      "Credential rotation revision is invalid.",
    );
  }
}

function instanceKey(instance: ConnectorInstance): string {
  return connectorInstanceKey(
    instance.connector.manifest.id,
    instance.instanceId,
  );
}

function connectorInstanceKey(connectorId: string, instanceId: string): string {
  return `${connectorId}:${instanceId}`;
}

function validateTimeout(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 100 || value > 300_000) {
    throw new Error(`${label} must be between 100 and 300000 ms.`);
  }
}

async function defaultSleep(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

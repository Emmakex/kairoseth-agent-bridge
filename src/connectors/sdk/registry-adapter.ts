import type { ToolRegistry } from "../../core/registry.js";
import type { InvocationContext, ToolDefinition } from "../../core/contracts.js";
import {
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
  sleep?: ((delayMs: number) => Promise<void>) | undefined;
  /** Set false only when an outer execution layer provides equivalent isolation. */
  circuitBreaker?: ConnectorCircuitBreaker | false | undefined;
}

const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 10_000;

export class ConnectorRegistryAdapter {
  private readonly defaultToolTimeoutMs: number;
  private readonly defaultHealthTimeoutMs: number;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly circuitBreaker: ConnectorCircuitBreaker | null;
  private readonly instances = new Map<string, ConnectorInstance>();

  constructor(
    private readonly registry: ToolRegistry,
    options: ConnectorRegistryAdapterOptions = {},
  ) {
    this.defaultToolTimeoutMs =
      options.defaultToolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    this.defaultHealthTimeoutMs =
      options.defaultHealthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
    this.sleep = options.sleep ?? defaultSleep;
    this.circuitBreaker =
      options.circuitBreaker === false
        ? null
        : options.circuitBreaker ?? new ConnectorCircuitBreaker();

    validateTimeout(this.defaultToolTimeoutMs, "default tool timeout");
    validateTimeout(this.defaultHealthTimeoutMs, "default health timeout");
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

  /**
   * Execute one connector-defined probe with bounded runtime and normalized
   * failure handling. Probe exceptions never escape into an aggregate health
   * collector and their raw messages are intentionally not exposed.
   */
  async health(instance: ConnectorInstance): Promise<ConnectorHealthResult> {
    validateConnectorDefinition(instance.connector);

    if (!instance.connector.health) {
      return {
        status: "healthy",
        checkedAt: new Date().toISOString(),
        details: { probe: "not_declared" },
      };
    }

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const probePromise: Promise<ConnectorHealthResult> = instance.connector
      .health({
        connectorId: instance.connector.manifest.id,
        connectorInstanceId: instance.instanceId,
        config: instance.config ?? {},
        secrets: instance.secrets,
        signal: controller.signal,
      })
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
    const probe = await this.health(instance);
    const tools = instance.connector.tools.map((tool) =>
      this.toolHealthSnapshot(instance, tool),
    );

    return {
      connectorId: instance.connector.manifest.id,
      connectorInstanceId: instance.instanceId,
      status: aggregateHealthStatus(probe.status, tools),
      checkedAt: probe.checkedAt,
      probe,
      tools,
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
  ): ConnectorToolHealthSnapshot {
    const runtimeToolId = connectorRuntimeToolId(
      instance.connector.manifest.id,
      instance.instanceId,
      tool.id,
    );

    if (!this.circuitBreaker) {
      return {
        toolId: tool.id,
        runtimeToolId,
        availability: "available",
      };
    }

    const circuit = this.circuitBreaker.snapshot(
      connectorCircuitKey(
        instance.connector.manifest.id,
        instance.instanceId,
        tool.id,
      ),
    );

    return {
      toolId: tool.id,
      runtimeToolId,
      availability: circuitAvailability(circuit),
      circuit,
    };
  }

  private async executeTool(
    instance: ConnectorInstance,
    tool: ConnectorToolDefinition,
    input: unknown,
    invocation: InvocationContext,
  ): Promise<unknown> {
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

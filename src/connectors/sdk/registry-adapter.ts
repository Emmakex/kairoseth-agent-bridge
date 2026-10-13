import type { ToolRegistry } from "../../core/registry.js";
import type { InvocationContext, ToolDefinition } from "../../core/contracts.js";
import {
  ConnectorTimeoutError,
  ConnectorTransientError,
} from "./errors.js";
import type {
  ConnectorDefinition,
  ConnectorHealthResult,
  ConnectorInstance,
  ConnectorRetryPolicy,
  ConnectorToolDefinition,
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
}

const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 10_000;

export class ConnectorRegistryAdapter {
  private readonly defaultToolTimeoutMs: number;
  private readonly defaultHealthTimeoutMs: number;
  private readonly sleep: (delayMs: number) => Promise<void>;

  constructor(
    private readonly registry: ToolRegistry,
    options: ConnectorRegistryAdapterOptions = {},
  ) {
    this.defaultToolTimeoutMs =
      options.defaultToolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    this.defaultHealthTimeoutMs =
      options.defaultHealthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
    this.sleep = options.sleep ?? defaultSleep;

    validateTimeout(this.defaultToolTimeoutMs, "default tool timeout");
    validateTimeout(this.defaultHealthTimeoutMs, "default health timeout");
  }

  register(instance: ConnectorInstance): RegisteredConnectorInstance {
    validateConnectorDefinition(instance.connector);
    const { manifest } = instance.connector;
    const runtimeToolIds: string[] = [];

    for (const tool of instance.connector.tools) {
      const runtimeToolId = connectorRuntimeToolId(
        manifest.id,
        instance.instanceId,
        tool.id,
      );

      const bridgeTool: ToolDefinition = {
        id: runtimeToolId,
        name: tool.name,
        description: tool.description,
        risk: tool.risk,
        execute: (input, invocation) =>
          this.executeTool(instance, tool, input, invocation),
      };

      this.registry.register(bridgeTool);
      runtimeToolIds.push(runtimeToolId);
    }

    return {
      connectorId: manifest.id,
      instanceId: instance.instanceId,
      toolIds: runtimeToolIds,
    };
  }

  async health(instance: ConnectorInstance): Promise<ConnectorHealthResult> {
    validateConnectorDefinition(instance.connector);

    if (!instance.connector.health) {
      return {
        status: "healthy",
        checkedAt: new Date().toISOString(),
        message: "Connector does not declare a custom health check.",
      };
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.defaultHealthTimeoutMs,
    );

    try {
      return await instance.connector.health({
        connectorId: instance.connector.manifest.id,
        connectorInstanceId: instance.instanceId,
        config: instance.config ?? {},
        secrets: instance.secrets,
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        return {
          status: "unhealthy",
          checkedAt: new Date().toISOString(),
          message: `Connector health check exceeded ${this.defaultHealthTimeoutMs} ms.`,
        };
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async executeTool(
    instance: ConnectorInstance,
    tool: ConnectorToolDefinition,
    input: unknown,
    invocation: InvocationContext,
  ): Promise<unknown> {
    const timeoutMs = tool.behavior?.timeoutMs ?? this.defaultToolTimeoutMs;
    const retry = normalizeRetry(tool.behavior?.retry);
    let attempt = 1;

    while (true) {
      try {
        return await this.executeAttempt(
          instance,
          tool,
          input,
          invocation,
          timeoutMs,
        );
      } catch (error) {
        const shouldRetry =
          error instanceof ConnectorTransientError &&
          retry.mode === "transient" &&
          attempt < retry.maxAttempts;

        if (!shouldRetry) {
          throw error;
        }

        const delayMs = retryDelayMs(retry, attempt);
        await this.sleep(delayMs);
        attempt += 1;
      }
    }
  }

  private async executeAttempt(
    instance: ConnectorInstance,
    tool: ConnectorToolDefinition,
    input: unknown,
    invocation: InvocationContext,
    timeoutMs: number,
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

function validateTimeout(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 100 || value > 300_000) {
    throw new Error(`${label} must be between 100 and 300000 ms.`);
  }
}

async function defaultSleep(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

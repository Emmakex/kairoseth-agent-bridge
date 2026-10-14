import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import type {
  BridgeInvocationResult,
  InvocationContext,
  SupportedLocale,
  ToolDefinition,
} from "../../core/contracts.js";
import type { BridgeRuntime } from "../../runtime/bridge-runtime.js";
import { createActionFingerprint } from "../../security/action-fingerprint.js";
import { canonicalJson } from "../../security/canonical-json.js";
import type {
  A2AArtifact,
  A2AExecutionContext,
  A2AGetTaskRequest,
  A2AMessage,
  A2APart,
  A2ASendMessageRequest,
  A2ASendMessageResponse,
  A2ATask,
  A2ATrustedInvocation,
  KairosethA2AToolInvocation,
} from "./execution-contracts.js";
import { A2AExecutionError } from "./execution-contracts.js";
import {
  InMemoryA2ATaskStore,
  type A2AStoredInvocation,
  type A2AStoredTask,
  type A2ATaskScope,
  type A2ATaskStore,
} from "./task-store.js";

export const KAIROSETH_A2A_TOOL_INVOCATION_EXTENSION_URI =
  "https://kairoseth.com/a2a/extensions/tool-invocation/v1";

const INVOCATION_VERSION = "kairoseth.tool-invocation.v1" as const;
const DEFAULT_MAX_INPUT_BYTES = 256 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_ID_LENGTH = 256;
const MAX_ACTOR_LENGTH = 512;

interface ExecutionMessages {
  approvalRequired: string;
  denied: string;
  failed: string;
  resultName: string;
  resultDescription: string;
  invalidRequest: string;
  unsupportedContent: string;
  extensionRequired: string;
  taskNotFound: string;
  unsupportedOperation: string;
  unauthenticated: string;
}

const MESSAGES: Readonly<Record<SupportedLocale, ExecutionMessages>> = {
  es: {
    approvalRequired: "Kairoseth requiere autorización para continuar esta acción.",
    denied: "Kairoseth ha rechazado esta acción según la política aplicable.",
    failed: "La ejecución ha fallado en Kairoseth Agent Bridge.",
    resultName: "Resultado de Kairoseth Agent Bridge",
    resultDescription: "Resultado estructurado de la herramienta ejecutada.",
    invalidRequest: "La solicitud A2A no es válida.",
    unsupportedContent: "El contenido A2A solicitado no está soportado.",
    extensionRequired: "La extensión de ejecución de Kairoseth debe estar activada.",
    taskNotFound: "La tarea A2A no existe o no es accesible para esta identidad.",
    unsupportedOperation: "La operación solicitada no está soportada para esta tarea A2A.",
    unauthenticated: "La identidad A2A autenticada no contiene el alcance requerido.",
  },
  en: {
    approvalRequired: "Kairoseth requires authorization before this action can continue.",
    denied: "Kairoseth rejected this action under the applicable policy.",
    failed: "Execution failed in Kairoseth Agent Bridge.",
    resultName: "Kairoseth Agent Bridge result",
    resultDescription: "Structured result produced by the executed tool.",
    invalidRequest: "The A2A request is invalid.",
    unsupportedContent: "The requested A2A content is not supported.",
    extensionRequired: "The Kairoseth execution extension must be activated.",
    taskNotFound: "The A2A task does not exist or is not accessible to this identity.",
    unsupportedOperation: "The requested operation is not supported for this A2A task.",
    unauthenticated: "The authenticated A2A identity is missing required scope.",
  },
};

export interface A2AToolExecutionAdapterOptions {
  taskStore?: A2ATaskStore | undefined;
  defaultLocale?: SupportedLocale | undefined;
  maxInputBytes?: number | undefined;
  maxOutputBytes?: number | undefined;
  idGenerator?: (() => string) | undefined;
  now?: (() => Date) | undefined;
}

/**
 * A protocol adapter, not an authorization layer. The trusted A2A host performs
 * transport authentication and extension negotiation, then this adapter routes
 * the exact structured action through BridgeRuntime so Kairoseth policy,
 * approvals and audit remain authoritative.
 */
export class A2AToolExecutionAdapter {
  private readonly taskStore: A2ATaskStore;
  private readonly defaultLocale: SupportedLocale;
  private readonly maxInputBytes: number;
  private readonly maxOutputBytes: number;
  private readonly idGenerator: () => string;
  private readonly now: () => Date;

  constructor(
    private readonly runtime: BridgeRuntime,
    options: A2AToolExecutionAdapterOptions = {},
  ) {
    this.taskStore = options.taskStore ?? new InMemoryA2ATaskStore();
    this.defaultLocale = options.defaultLocale ?? "en";
    this.maxInputBytes = normalizeByteLimit(
      options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES,
      "maxInputBytes",
    );
    this.maxOutputBytes = normalizeByteLimit(
      options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      "maxOutputBytes",
    );
    this.idGenerator = options.idGenerator ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  async sendMessage(
    request: A2ASendMessageRequest,
    context: A2AExecutionContext,
  ): Promise<A2ASendMessageResponse> {
    const locale = context.locale ?? this.defaultLocale;
    validateTrustedContext(context, locale);
    validateSendRequestShape(request, locale);
    requireActivatedExtension(request.message, context, locale);
    const parsed = this.parseInvocation(request.message, locale);
    const scope = scopeFrom(context.invocation);

    if (request.message.taskId) {
      return {
        task: await this.resumeTask(request, parsed, context, scope, locale),
      };
    }

    const taskId = this.generateId(locale);
    const contextId = request.message.contextId
      ? validateId(request.message.contextId, locale)
      : this.generateId(locale);
    const storedInvocation = this.createStoredInvocation(
      parsed,
      context.invocation,
    );
    const task = await this.invokeToTask(
      taskId,
      contextId,
      request.message.messageId,
      storedInvocation,
      context.invocation,
      locale,
    );

    await this.taskStore.save({ task, scope, invocation: storedInvocation });
    return { task };
  }

  async getTask(
    request: A2AGetTaskRequest,
    context: A2AExecutionContext,
  ): Promise<A2ATask> {
    const locale = context.locale ?? this.defaultLocale;
    validateTrustedContext(context, locale);
    validateTaskRequest(request, locale);
    const record = await this.taskStore.get(
      validateId(request.id, locale),
      scopeFrom(context.invocation),
    );
    if (!record) {
      fail("TASK_NOT_FOUND", locale);
    }
    return structuredClone(record.task);
  }

  private async resumeTask(
    request: A2ASendMessageRequest,
    parsed: KairosethA2AToolInvocation,
    context: A2AExecutionContext,
    scope: A2ATaskScope,
    locale: SupportedLocale,
  ): Promise<A2ATask> {
    const taskId = validateId(request.message.taskId!, locale);
    const record = await this.taskStore.get(taskId, scope);
    if (!record) {
      fail("TASK_NOT_FOUND", locale);
    }

    if (record.task.status.state !== "TASK_STATE_AUTH_REQUIRED") {
      fail("UNSUPPORTED_OPERATION", locale);
    }
    if (
      request.message.contextId !== undefined &&
      request.message.contextId !== record.task.contextId
    ) {
      fail("INVALID_REQUEST", locale);
    }

    const resumedFingerprint = createActionFingerprint({
      tenantId: scope.tenantId,
      installationId: scope.installationId,
      toolId: parsed.toolId,
      correlationId: record.invocation.correlationId,
      input: parsed.input,
    });
    if (
      parsed.toolId !== record.invocation.toolId ||
      resumedFingerprint !== record.invocation.actionFingerprint
    ) {
      fail("INVALID_REQUEST", locale);
    }

    const invocation: A2ATrustedInvocation = {
      ...context.invocation,
      correlationId: record.invocation.correlationId,
    };
    const updatedTask = await this.invokeToTask(
      record.task.id,
      record.task.contextId ?? this.generateId(locale),
      request.message.messageId,
      record.invocation,
      invocation,
      locale,
    );
    await this.taskStore.save({
      task: updatedTask,
      scope,
      invocation: record.invocation,
    });
    return updatedTask;
  }

  private parseInvocation(
    message: A2AMessage,
    locale: SupportedLocale,
  ): KairosethA2AToolInvocation {
    validateId(message.messageId, locale);
    if (message.role !== "ROLE_USER") {
      fail("INVALID_REQUEST", locale);
    }
    if (!Array.isArray(message.parts) || message.parts.length !== 1) {
      fail("CONTENT_TYPE_NOT_SUPPORTED", locale);
    }

    const part = message.parts[0]!;
    const contentKeys = ["text", "raw", "url", "data"].filter((key) =>
      Object.prototype.hasOwnProperty.call(part, key),
    );
    if (contentKeys.length !== 1 || contentKeys[0] !== "data") {
      fail("CONTENT_TYPE_NOT_SUPPORTED", locale);
    }
    if (
      part.mediaType !== undefined &&
      part.mediaType.trim().toLowerCase() !== "application/json"
    ) {
      fail("CONTENT_TYPE_NOT_SUPPORTED", locale);
    }

    const data = part.data;
    if (!isPlainObject(data)) {
      fail("INVALID_REQUEST", locale);
    }
    const keys = Object.keys(data).sort(compareStrings);
    if (
      keys.length !== 3 ||
      keys[0] !== "input" ||
      keys[1] !== "toolId" ||
      keys[2] !== "version"
    ) {
      fail("INVALID_REQUEST", locale);
    }
    if (data.version !== INVOCATION_VERSION) {
      fail("INVALID_REQUEST", locale);
    }
    if (typeof data.toolId !== "string") {
      fail("INVALID_REQUEST", locale);
    }
    validateId(data.toolId, locale);

    let encodedInput: string;
    try {
      encodedInput = canonicalJson(data.input);
    } catch {
      fail("INVALID_REQUEST", locale);
    }
    if (Buffer.byteLength(encodedInput, "utf8") > this.maxInputBytes) {
      fail("INVALID_REQUEST", locale);
    }

    const tool = this.runtime.registry.get(data.toolId);
    if (!tool || !isA2APublishedTool(tool)) {
      fail("INVALID_REQUEST", locale);
    }

    return {
      version: INVOCATION_VERSION,
      toolId: data.toolId,
      input: structuredClone(data.input),
    };
  }

  private createStoredInvocation(
    parsed: KairosethA2AToolInvocation,
    invocation: A2ATrustedInvocation,
  ): A2AStoredInvocation {
    return {
      toolId: parsed.toolId,
      input: structuredClone(parsed.input),
      correlationId: invocation.correlationId,
      actionFingerprint: createActionFingerprint({
        tenantId: invocation.tenantId,
        installationId: invocation.installationId,
        toolId: parsed.toolId,
        correlationId: invocation.correlationId,
        input: parsed.input,
      }),
    };
  }

  private async invokeToTask(
    taskId: string,
    contextId: string,
    messageId: string,
    storedInvocation: A2AStoredInvocation,
    invocation: A2ATrustedInvocation,
    locale: SupportedLocale,
  ): Promise<A2ATask> {
    const coreContext = invocationContextForA2A(
      invocation,
      taskId,
      contextId,
      messageId,
      storedInvocation.toolId,
    );
    const result = await this.runtime.invoke(
      storedInvocation.toolId,
      structuredClone(storedInvocation.input),
      coreContext,
    );
    return this.taskFromResult(
      taskId,
      contextId,
      storedInvocation.toolId,
      result,
      locale,
    );
  }

  private taskFromResult(
    taskId: string,
    contextId: string,
    toolId: string,
    result: BridgeInvocationResult,
    locale: SupportedLocale,
  ): A2ATask {
    const base: Pick<A2ATask, "id" | "contextId" | "metadata"> = {
      id: taskId,
      contextId,
      metadata: {
        "kairoseth.protocol": "a2a",
        "kairoseth.toolId": toolId,
        "kairoseth.correlationId": result.correlationId,
      },
    };

    switch (result.status) {
      case "executed": {
        const output = normalizeJsonOutput(result.output, this.maxOutputBytes, locale);
        const artifact: A2AArtifact = {
          artifactId: this.generateId(locale),
          name: MESSAGES[locale].resultName,
          description: MESSAGES[locale].resultDescription,
          parts: [
            {
              data: output,
              mediaType: "application/json",
              metadata: { "kairoseth.toolId": toolId },
            },
          ],
          extensions: [KAIROSETH_A2A_TOOL_INVOCATION_EXTENSION_URI],
        };
        return {
          ...base,
          status: {
            state: "TASK_STATE_COMPLETED",
            timestamp: this.timestamp(),
          },
          artifacts: [artifact],
        };
      }
      case "approval_required":
        return {
          ...base,
          status: {
            state: "TASK_STATE_AUTH_REQUIRED",
            timestamp: this.timestamp(),
            message: this.statusMessage(
              taskId,
              contextId,
              MESSAGES[locale].approvalRequired,
              "KAIROSETH_APPROVAL_REQUIRED",
            ),
          },
        };
      case "denied":
        return {
          ...base,
          status: {
            state: "TASK_STATE_REJECTED",
            timestamp: this.timestamp(),
            message: this.statusMessage(
              taskId,
              contextId,
              MESSAGES[locale].denied,
              "KAIROSETH_DENIED",
            ),
          },
        };
      case "failed":
        return {
          ...base,
          status: {
            state: "TASK_STATE_FAILED",
            timestamp: this.timestamp(),
            message: this.statusMessage(
              taskId,
              contextId,
              MESSAGES[locale].failed,
              "KAIROSETH_EXECUTION_FAILED",
            ),
          },
        };
    }
  }

  private statusMessage(
    taskId: string,
    contextId: string,
    text: string,
    code: string,
  ): A2AMessage {
    return {
      messageId: this.generateId(this.defaultLocale),
      taskId,
      contextId,
      role: "ROLE_AGENT",
      parts: [{ text, mediaType: "text/plain" }],
      metadata: { "kairoseth.code": code },
      extensions: [KAIROSETH_A2A_TOOL_INVOCATION_EXTENSION_URI],
    };
  }

  private generateId(locale: SupportedLocale): string {
    let value: string;
    try {
      value = this.idGenerator();
    } catch {
      fail("INVALID_REQUEST", locale);
    }
    return validateId(value!, locale);
  }

  private timestamp(): string {
    const date = this.now();
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
      throw new Error("A2A execution clock returned an invalid Date.");
    }
    return date.toISOString();
  }
}

function invocationContextForA2A(
  invocation: A2ATrustedInvocation,
  taskId: string,
  contextId: string,
  messageId: string,
  toolId: string,
): InvocationContext {
  return {
    correlationId: invocation.correlationId,
    actor: invocation.actor,
    tenantId: invocation.tenantId,
    installationId: invocation.installationId,
    ...(invocation.approvalToken !== undefined
      ? { approvalToken: invocation.approvalToken }
      : {}),
    metadata: {
      ...(invocation.metadata ?? {}),
      protocol: "a2a",
      "a2a.taskId": taskId,
      "a2a.contextId": contextId,
      "a2a.messageId": messageId,
      "a2a.toolId": toolId,
    },
  };
}

function requireActivatedExtension(
  message: A2AMessage,
  context: A2AExecutionContext,
  locale: SupportedLocale,
): void {
  if (
    !context.activatedExtensions.includes(
      KAIROSETH_A2A_TOOL_INVOCATION_EXTENSION_URI,
    ) ||
    !message.extensions?.includes(
      KAIROSETH_A2A_TOOL_INVOCATION_EXTENSION_URI,
    )
  ) {
    fail("EXTENSION_REQUIRED", locale);
  }
}

function validateTrustedContext(
  context: A2AExecutionContext,
  locale: SupportedLocale,
): void {
  if (context.protocolVersion !== "1.0") {
    fail("INVALID_REQUEST", locale);
  }
  if (!Array.isArray(context.activatedExtensions)) {
    fail("INVALID_REQUEST", locale);
  }
  const invocation = context.invocation;
  if (
    !boundedIdentifier(invocation.actor, MAX_ACTOR_LENGTH) ||
    !boundedIdentifier(invocation.tenantId, MAX_ID_LENGTH) ||
    !boundedIdentifier(invocation.installationId, MAX_ID_LENGTH) ||
    !boundedIdentifier(invocation.correlationId, MAX_ID_LENGTH)
  ) {
    fail("UNAUTHENTICATED", locale);
  }
}

function validateSendRequestShape(
  request: A2ASendMessageRequest,
  locale: SupportedLocale,
): void {
  if (!request || typeof request !== "object" || !request.message) {
    fail("INVALID_REQUEST", locale);
  }
  if (request.tenant !== undefined) {
    validateId(request.tenant, locale);
  }
  const configuration = request.configuration;
  if (configuration?.returnImmediately === true) {
    fail("UNSUPPORTED_OPERATION", locale);
  }
  if (
    configuration?.historyLength !== undefined &&
    (!Number.isInteger(configuration.historyLength) || configuration.historyLength < 0)
  ) {
    fail("INVALID_REQUEST", locale);
  }
  if (configuration?.acceptedOutputModes !== undefined) {
    if (
      !Array.isArray(configuration.acceptedOutputModes) ||
      !configuration.acceptedOutputModes.some(
        (mode) => mode.trim().toLowerCase() === "application/json",
      )
    ) {
      fail("CONTENT_TYPE_NOT_SUPPORTED", locale);
    }
  }
}

function validateTaskRequest(
  request: A2AGetTaskRequest,
  locale: SupportedLocale,
): void {
  if (!request || typeof request !== "object") {
    fail("INVALID_REQUEST", locale);
  }
  validateId(request.id, locale);
  if (request.tenant !== undefined) validateId(request.tenant, locale);
  if (
    request.historyLength !== undefined &&
    (!Number.isInteger(request.historyLength) || request.historyLength < 0)
  ) {
    fail("INVALID_REQUEST", locale);
  }
}

function normalizeJsonOutput(
  output: unknown,
  maxBytes: number,
  locale: SupportedLocale,
): unknown {
  let encoded: string;
  try {
    encoded = canonicalJson(output);
  } catch {
    fail("CONTENT_TYPE_NOT_SUPPORTED", locale);
  }
  if (Buffer.byteLength(encoded!, "utf8") > maxBytes) {
    fail("CONTENT_TYPE_NOT_SUPPORTED", locale);
  }
  return structuredClone(output);
}

function isA2APublishedTool(tool: ToolDefinition): boolean {
  return (["es", "en"] as const).every((locale) => {
    const text = tool.localizations?.[locale];
    return Boolean(text?.name.trim() && text.description.trim());
  });
}

function scopeFrom(invocation: A2ATrustedInvocation): A2ATaskScope {
  return {
    actor: invocation.actor,
    tenantId: invocation.tenantId,
    installationId: invocation.installationId,
  };
}

function validateId(value: string, locale: SupportedLocale): string {
  if (!boundedIdentifier(value, MAX_ID_LENGTH)) {
    fail("INVALID_REQUEST", locale);
  }
  return value;
}

function boundedIdentifier(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function normalizeByteLimit(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 16 * 1024 * 1024) {
    throw new Error(`${label} must be an integer between 1 and 16777216 bytes.`);
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(
  code:
    | "INVALID_REQUEST"
    | "CONTENT_TYPE_NOT_SUPPORTED"
    | "EXTENSION_REQUIRED"
    | "TASK_NOT_FOUND"
    | "UNSUPPORTED_OPERATION"
    | "UNAUTHENTICATED",
  locale: SupportedLocale,
): never {
  const messages = MESSAGES[locale];
  const message =
    code === "INVALID_REQUEST"
      ? messages.invalidRequest
      : code === "CONTENT_TYPE_NOT_SUPPORTED"
        ? messages.unsupportedContent
        : code === "EXTENSION_REQUIRED"
          ? messages.extensionRequired
          : code === "TASK_NOT_FOUND"
            ? messages.taskNotFound
            : code === "UNSUPPORTED_OPERATION"
              ? messages.unsupportedOperation
              : messages.unauthenticated;
  throw new A2AExecutionError(code, message);
}

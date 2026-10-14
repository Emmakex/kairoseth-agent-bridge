import type {
  InvocationContext,
  SupportedLocale,
} from "../../core/contracts.js";

export type A2ARole = "ROLE_USER" | "ROLE_AGENT";

export type A2ATaskState =
  | "TASK_STATE_UNSPECIFIED"
  | "TASK_STATE_SUBMITTED"
  | "TASK_STATE_WORKING"
  | "TASK_STATE_COMPLETED"
  | "TASK_STATE_FAILED"
  | "TASK_STATE_CANCELED"
  | "TASK_STATE_INPUT_REQUIRED"
  | "TASK_STATE_REJECTED"
  | "TASK_STATE_AUTH_REQUIRED";

/**
 * Canonical A2A Part shape. Runtime validation enforces exactly one content
 * field (text, raw, url or data) when accepting untrusted messages.
 */
export interface A2APart {
  text?: string | undefined;
  raw?: string | undefined;
  url?: string | undefined;
  data?: unknown;
  metadata?: Readonly<Record<string, unknown>> | undefined;
  filename?: string | undefined;
  mediaType?: string | undefined;
}

export interface A2AMessage {
  messageId: string;
  contextId?: string | undefined;
  taskId?: string | undefined;
  role: A2ARole;
  parts: readonly A2APart[];
  metadata?: Readonly<Record<string, unknown>> | undefined;
  extensions?: readonly string[] | undefined;
  referenceTaskIds?: readonly string[] | undefined;
}

export interface A2AArtifact {
  artifactId: string;
  name?: string | undefined;
  description?: string | undefined;
  parts: readonly A2APart[];
  metadata?: Readonly<Record<string, unknown>> | undefined;
  extensions?: readonly string[] | undefined;
}

export interface A2ATaskStatus {
  state: A2ATaskState;
  message?: A2AMessage | undefined;
  timestamp?: string | undefined;
}

export interface A2ATask {
  id: string;
  contextId?: string | undefined;
  status: A2ATaskStatus;
  artifacts?: readonly A2AArtifact[] | undefined;
  history?: readonly A2AMessage[] | undefined;
  metadata?: Readonly<Record<string, unknown>> | undefined;
}

export interface A2ASendMessageConfiguration {
  acceptedOutputModes?: readonly string[] | undefined;
  historyLength?: number | undefined;
  returnImmediately?: boolean | undefined;
}

export interface A2ASendMessageRequest {
  tenant?: string | undefined;
  message: A2AMessage;
  configuration?: A2ASendMessageConfiguration | undefined;
  metadata?: Readonly<Record<string, unknown>> | undefined;
}

export type A2ASendMessageResponse =
  | { task: A2ATask; message?: never }
  | { message: A2AMessage; task?: never };

export interface A2AGetTaskRequest {
  tenant?: string | undefined;
  id: string;
  historyLength?: number | undefined;
}

export type A2ATrustedInvocation = InvocationContext & {
  tenantId: string;
  installationId: string;
};

/**
 * Supplied by the trusted A2A transport/host after protocol-version,
 * authentication and extension negotiation. None of these fields are derived
 * from untrusted Message.metadata.
 */
export interface A2AExecutionContext {
  protocolVersion: "1.0";
  activatedExtensions: readonly string[];
  invocation: A2ATrustedInvocation;
  locale?: SupportedLocale | undefined;
}

export interface KairosethA2AToolInvocation {
  version: "kairoseth.tool-invocation.v1";
  toolId: string;
  input: unknown;
}

export type A2AExecutionErrorCode =
  | "INVALID_REQUEST"
  | "CONTENT_TYPE_NOT_SUPPORTED"
  | "EXTENSION_REQUIRED"
  | "TASK_NOT_FOUND"
  | "UNSUPPORTED_OPERATION"
  | "UNAUTHENTICATED";

export class A2AExecutionError extends Error {
  constructor(
    readonly code: A2AExecutionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "A2AExecutionError";
  }
}

import { randomUUID } from "node:crypto";

import type { AuditEvent, AuditSink } from "../core/contracts.js";
import type { AuditOutboxStore, SanitizedAuditEvent } from "./outbox.js";

export interface AuditScope {
  tenantId: string;
  installationId: string;
  bridgeInstanceId: string;
}

export interface SanitizedAuditSinkOptions {
  maxMessageLength?: number | undefined;
  maxIdentifierLength?: number | undefined;
}

const DEFAULT_MAX_MESSAGE_LENGTH = 512;
const DEFAULT_MAX_IDENTIFIER_LENGTH = 256;

const SECRET_PATTERNS: readonly RegExp[] = [
  /kab1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  /Bearer\s+[A-Za-z0-9._~+\/-]+/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|authorization)\b\s*[:=]\s*[^\s,;]+/gi,
];

export class SanitizedAuditSink implements AuditSink {
  private readonly maxMessageLength: number;
  private readonly maxIdentifierLength: number;

  constructor(
    private readonly scope: AuditScope,
    private readonly outbox: AuditOutboxStore,
    options: SanitizedAuditSinkOptions = {},
  ) {
    this.maxMessageLength =
      options.maxMessageLength ?? DEFAULT_MAX_MESSAGE_LENGTH;
    this.maxIdentifierLength =
      options.maxIdentifierLength ?? DEFAULT_MAX_IDENTIFIER_LENGTH;

    if (this.maxMessageLength < 32 || this.maxIdentifierLength < 32) {
      throw new Error("Audit sanitization limits are too small.");
    }

    validateScope(scope);
  }

  async emit(event: AuditEvent): Promise<void> {
    const sanitized: SanitizedAuditEvent = {
      version: "kab.audit-event.v1",
      eventId: randomUUID(),
      tenantId: this.scope.tenantId,
      installationId: this.scope.installationId,
      bridgeInstanceId: this.scope.bridgeInstanceId,
      type: event.type,
      correlationId: sanitizeIdentifier(
        event.correlationId,
        this.maxIdentifierLength,
        "correlationId",
      ),
      toolId: sanitizeIdentifier(
        event.toolId,
        this.maxIdentifierLength,
        "toolId",
      ),
      actor: sanitizeIdentifier(
        event.actor,
        this.maxIdentifierLength,
        "actor",
      ),
      risk: event.risk,
      occurredAt: normalizeTimestamp(event.occurredAt),
      ...(event.outcome ? { outcome: event.outcome } : {}),
      ...(event.message
        ? { message: sanitizeAuditMessage(event.message, this.maxMessageLength) }
        : {}),
    };

    await this.outbox.enqueue(sanitized);
  }
}

export function sanitizeAuditMessage(
  message: string,
  maxLength = DEFAULT_MAX_MESSAGE_LENGTH,
): string {
  let sanitized = message.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");

  for (const pattern of SECRET_PATTERNS) {
    sanitized = sanitized.replace(pattern, (_match, secretName?: string) => {
      if (typeof secretName === "string" && secretName.length > 0) {
        return `${secretName}=[REDACTED]`;
      }
      return "[REDACTED]";
    });
  }

  if (sanitized.length > maxLength) {
    const suffix = "...[TRUNCATED]";
    return `${sanitized.slice(0, Math.max(0, maxLength - suffix.length))}${suffix}`;
  }

  return sanitized;
}

function validateScope(scope: AuditScope): void {
  if (!scope.tenantId || !scope.installationId || !scope.bridgeInstanceId) {
    throw new Error("Audit scope requires tenant, installation and bridge instance IDs.");
  }
}

function sanitizeIdentifier(
  value: string,
  maxLength: number,
  field: string,
): string {
  const normalized = value.replace(/[\r\n\t]/g, " ").trim();

  if (!normalized) {
    throw new Error(`Audit ${field} is required.`);
  }

  return normalized.slice(0, maxLength);
}

function normalizeTimestamp(value: string): string {
  const timestamp = Date.parse(value);

  if (!Number.isFinite(timestamp)) {
    throw new Error("Audit event timestamp is invalid.");
  }

  return new Date(timestamp).toISOString();
}

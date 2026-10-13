import type { ConnectorSecretProvider, JsonSchema } from "../sdk/contracts.js";

export type WebhookAuthDefinition =
  | {
      type: "hmac_sha256";
      requirementId: string;
      secretField: string;
      signatureHeader?: string | undefined;
      signaturePrefix?: string | undefined;
    }
  | {
      type: "bearer";
      requirementId: string;
      tokenField: string;
      authorizationHeader?: string | undefined;
    };

export interface WebhookReplayPolicy {
  /** Header containing Unix seconds. */
  timestampHeader?: string | undefined;
  /** Header containing an opaque unique delivery nonce/event ID. */
  nonceHeader?: string | undefined;
  /** Maximum absolute clock skew. Defaults to 300 seconds. */
  toleranceSeconds?: number | undefined;
  /** How long a consumed nonce remains reserved. Defaults to tolerance * 2. */
  retainSeconds?: number | undefined;
}

export interface WebhookDefinition {
  id: string;
  name: string;
  description: string;
  /** Fixed route expected from the HTTP packaging layer. */
  path: string;
  auth: WebhookAuthDefinition;
  replay?: WebhookReplayPolicy | undefined;
  payloadSchema?: JsonSchema | undefined;
  /** Maximum raw request body bytes. Defaults to 1 MiB, hard capped at 5 MiB. */
  maxBodyBytes?: number | undefined;
  /** Additional JSON keys to redact before event emission. */
  redactKeys?: readonly string[] | undefined;
}

export interface WebhookHttpRequest {
  method: string;
  path: string;
  /** Header names are matched case-insensitively by the adapter. */
  headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  /** Raw bytes are required because signatures are verified before JSON parsing. */
  body: Uint8Array;
}

export interface NormalizedWebhookEvent {
  version: "kab.webhook-event.v1";
  eventId: string;
  webhookId: string;
  receivedAt: string;
  sourceTimestamp: string;
  nonce: string;
  payload: unknown;
}

export interface WebhookEventSink {
  emit(event: NormalizedWebhookEvent): Promise<void>;
}

export class InMemoryWebhookEventSink implements WebhookEventSink {
  private readonly events: NormalizedWebhookEvent[] = [];

  async emit(event: NormalizedWebhookEvent): Promise<void> {
    this.events.push(structuredClone(event));
  }

  all(): readonly NormalizedWebhookEvent[] {
    return structuredClone(this.events);
  }
}

export interface WebhookAdapterContext {
  secrets: ConnectorSecretProvider;
}

export interface WebhookHandlingResult {
  accepted: true;
  eventId: string;
}

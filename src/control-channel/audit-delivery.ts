import { randomUUID } from "node:crypto";

import type { AuditOutboxStore, SanitizedAuditEvent } from "../audit/outbox.js";
import type { ControlSession } from "./session.js";

export interface AuditBatch {
  version: "kab.audit-batch.v1";
  batchId: string;
  sessionId: string;
  tenantId: string;
  installationId: string;
  bridgeInstanceId: string;
  events: readonly SanitizedAuditEvent[];
}

export interface AuditBatchAcknowledgement {
  version: "kab.audit-batch-ack.v1";
  batchId: string;
  acceptedEventIds: readonly string[];
}

export interface AuditDeliveryTransport {
  sendAuditBatch(
    accessToken: string,
    batch: AuditBatch,
  ): Promise<AuditBatchAcknowledgement>;
}

export interface AuditDeliveryOptions {
  maxBatchSize?: number | undefined;
}

export interface AuditFlushResult {
  batchId: string | null;
  sent: number;
  acknowledged: number;
  remaining: number;
}

export class AuditDeliveryClient {
  private readonly maxBatchSize: number;

  constructor(
    private readonly session: ControlSession,
    private readonly outbox: AuditOutboxStore,
    private readonly transport: AuditDeliveryTransport,
    options: AuditDeliveryOptions = {},
  ) {
    this.maxBatchSize = options.maxBatchSize ?? 100;

    if (!Number.isInteger(this.maxBatchSize) || this.maxBatchSize < 1 || this.maxBatchSize > 500) {
      throw new Error("Audit delivery batch size must be between 1 and 500.");
    }
  }

  async flushOnce(): Promise<AuditFlushResult> {
    if (this.session.isExpired()) {
      throw new Error("Cannot deliver audit events with an expired control session.");
    }

    const events = await this.outbox.peek(this.maxBatchSize);

    if (events.length === 0) {
      return {
        batchId: null,
        sent: 0,
        acknowledged: 0,
        remaining: 0,
      };
    }

    const { credential } = this.session;
    this.validateEventScope(events, credential.tenantId, credential.installationId, credential.bridgeInstanceId);

    const batch: AuditBatch = {
      version: "kab.audit-batch.v1",
      batchId: randomUUID(),
      sessionId: credential.sessionId,
      tenantId: credential.tenantId,
      installationId: credential.installationId,
      bridgeInstanceId: credential.bridgeInstanceId,
      events,
    };

    const acknowledgement = await this.transport.sendAuditBatch(
      credential.accessToken,
      batch,
    );

    this.validateAcknowledgement(batch, acknowledgement);
    const acknowledged = await this.outbox.acknowledge(
      acknowledgement.acceptedEventIds,
    );

    return {
      batchId: batch.batchId,
      sent: events.length,
      acknowledged,
      remaining: await this.outbox.size(),
    };
  }

  private validateEventScope(
    events: readonly SanitizedAuditEvent[],
    tenantId: string,
    installationId: string,
    bridgeInstanceId: string,
  ): void {
    for (const event of events) {
      if (
        event.tenantId !== tenantId ||
        event.installationId !== installationId ||
        event.bridgeInstanceId !== bridgeInstanceId
      ) {
        throw new Error("Audit outbox contains an event for another control-session scope.");
      }
    }
  }

  private validateAcknowledgement(
    batch: AuditBatch,
    acknowledgement: AuditBatchAcknowledgement,
  ): void {
    if (acknowledgement.version !== "kab.audit-batch-ack.v1") {
      throw new Error("Unsupported audit batch acknowledgement version.");
    }

    if (acknowledgement.batchId !== batch.batchId) {
      throw new Error("Audit acknowledgement targets a different batch.");
    }

    const sentIds = new Set(batch.events.map((event) => event.eventId));
    const acceptedIds = new Set<string>();

    for (const eventId of acknowledgement.acceptedEventIds) {
      if (!sentIds.has(eventId)) {
        throw new Error("Audit acknowledgement contains an event ID that was not sent.");
      }

      if (acceptedIds.has(eventId)) {
        throw new Error("Audit acknowledgement contains duplicate event IDs.");
      }

      acceptedIds.add(eventId);
    }
  }
}

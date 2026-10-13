import type { AuditEvent, AuditSink } from "./contracts.js";

export class NoopAuditSink implements AuditSink {
  async emit(_event: AuditEvent): Promise<void> {
    // Intentionally empty. Production deployments inject a Kairoseth-backed sink.
  }
}

export class MemoryAuditSink implements AuditSink {
  private readonly events: AuditEvent[] = [];

  async emit(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }

  all(): readonly AuditEvent[] {
    return [...this.events];
  }
}

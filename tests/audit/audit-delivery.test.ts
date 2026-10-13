import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AuditDeliveryClient,
  ControlSession,
  FileAuditOutboxStore,
  InMemoryAuditOutboxStore,
  SanitizedAuditSink,
  sanitizeAuditMessage,
  type AuditBatch,
  type AuditDeliveryTransport,
  type AuditEvent,
  type OutboundSessionTransport,
  type SessionCredential,
} from "../../src/index.js";

const NOW = new Date("2026-10-13T15:30:00.000Z");

const credential: SessionCredential = {
  version: "kab.session-credential.v1",
  sessionId: "session-audit-1",
  tenantId: "tenant-1",
  installationId: "installation-1",
  bridgeInstanceId: "bridge-1",
  keyId: "bridge-key-1",
  accessToken: "session-secret",
  issuedAt: "2026-10-13T15:29:00.000Z",
  expiresAt: "2026-10-13T16:00:00.000Z",
  heartbeatIntervalSeconds: 15,
};

const unusedSessionTransport: OutboundSessionTransport = {
  async requestSessionChallenge() {
    throw new Error("not used");
  },
  async openSession() {
    throw new Error("not used");
  },
  async sendHeartbeat() {
    throw new Error("not used");
  },
};

function createSession(): ControlSession {
  return new ControlSession(credential, unusedSessionTransport, {
    runtimeVersion: "0.1.0",
    now: () => NOW,
  });
}

function sourceEvent(message?: string): AuditEvent {
  return {
    type: "EXECUTION_FAILED",
    correlationId: "corr-audit-1",
    toolId: "orders.update",
    actor: "agent-1",
    risk: "WRITE",
    occurredAt: NOW.toISOString(),
    outcome: "ALLOW",
    ...(message ? { message } : {}),
  };
}

async function enqueueOne(outbox: InMemoryAuditOutboxStore | FileAuditOutboxStore): Promise<string> {
  const sink = new SanitizedAuditSink(
    {
      tenantId: credential.tenantId,
      installationId: credential.installationId,
      bridgeInstanceId: credential.bridgeInstanceId,
    },
    outbox,
  );

  await sink.emit(sourceEvent("safe message"));
  return (await outbox.peek(1))[0]!.eventId;
}

test("audit message sanitizer redacts common secret forms before persistence", async () => {
  const outbox = new InMemoryAuditOutboxStore();
  const sink = new SanitizedAuditSink(
    {
      tenantId: credential.tenantId,
      installationId: credential.installationId,
      bridgeInstanceId: credential.bridgeInstanceId,
    },
    outbox,
  );

  const approval = "kab1.a2V5.cGF5bG9hZA.c2lnbmF0dXJl";
  const privateKey =
    "-----BEGIN PRIVATE KEY-----\nsecret-material\n-----END PRIVATE KEY-----";
  const message = `Bearer abc.def password=hunter2 token=token-value ${approval} ${privateKey}`;

  await sink.emit(sourceEvent(message));
  const stored = (await outbox.peek(1))[0]!;

  assert.equal(stored.version, "kab.audit-event.v1");
  assert.doesNotMatch(stored.message ?? "", /hunter2/);
  assert.doesNotMatch(stored.message ?? "", /token-value/);
  assert.doesNotMatch(stored.message ?? "", /abc\.def/);
  assert.doesNotMatch(stored.message ?? "", /kab1\./);
  assert.doesNotMatch(stored.message ?? "", /secret-material/);
  assert.match(stored.message ?? "", /\[REDACTED\]/);
});

test("audit message sanitizer enforces a bounded message size", () => {
  const sanitized = sanitizeAuditMessage("x".repeat(2_000), 128);
  assert.ok(sanitized.length <= 128);
  assert.match(sanitized, /\[TRUNCATED\]$/);
});

test("filesystem audit outbox survives restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kab-audit-"));
  const filePath = join(directory, "audit-outbox.json");

  try {
    const first = new FileAuditOutboxStore(filePath);
    const eventId = await enqueueOne(first);

    const restarted = new FileAuditOutboxStore(filePath);
    const pending = await restarted.peek(10);

    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.eventId, eventId);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("lost delivery response keeps event and retry preserves eventId", async () => {
  const outbox = new InMemoryAuditOutboxStore();
  const eventId = await enqueueOne(outbox);
  const seenEventIds: string[] = [];
  let attempts = 0;

  const transport: AuditDeliveryTransport = {
    async sendAuditBatch(_accessToken, batch) {
      attempts += 1;
      seenEventIds.push(batch.events[0]!.eventId);

      if (attempts === 1) {
        throw new Error("network dropped after send");
      }

      return {
        version: "kab.audit-batch-ack.v1",
        batchId: batch.batchId,
        acceptedEventIds: batch.events.map((event) => event.eventId),
      };
    },
  };
  const client = new AuditDeliveryClient(createSession(), outbox, transport);

  await assert.rejects(() => client.flushOnce(), /network dropped/);
  assert.equal(await outbox.size(), 1);

  const retry = await client.flushOnce();

  assert.equal(retry.acknowledged, 1);
  assert.equal(retry.remaining, 0);
  assert.deepEqual(seenEventIds, [eventId, eventId]);
});

test("partial acknowledgement removes only accepted audit events", async () => {
  const outbox = new InMemoryAuditOutboxStore();
  const firstId = await enqueueOne(outbox);
  const secondId = await enqueueOne(outbox);

  const transport: AuditDeliveryTransport = {
    async sendAuditBatch(_accessToken, batch) {
      return {
        version: "kab.audit-batch-ack.v1",
        batchId: batch.batchId,
        acceptedEventIds: [firstId],
      };
    },
  };

  const result = await new AuditDeliveryClient(
    createSession(),
    outbox,
    transport,
  ).flushOnce();

  assert.equal(result.sent, 2);
  assert.equal(result.acknowledged, 1);
  assert.equal(result.remaining, 1);
  assert.equal((await outbox.peek(1))[0]!.eventId, secondId);
});

test("delivery rejects outbox events scoped to another runtime", async () => {
  const outbox = new InMemoryAuditOutboxStore();
  const sink = new SanitizedAuditSink(
    {
      tenantId: "other-tenant",
      installationId: credential.installationId,
      bridgeInstanceId: credential.bridgeInstanceId,
    },
    outbox,
  );
  await sink.emit(sourceEvent("scope mismatch"));

  const transport: AuditDeliveryTransport = {
    async sendAuditBatch() {
      throw new Error("must not send");
    },
  };

  await assert.rejects(
    () => new AuditDeliveryClient(createSession(), outbox, transport).flushOnce(),
    /another control-session scope/,
  );
  assert.equal(await outbox.size(), 1);
});

test("acknowledgement cannot delete an event ID that was not sent", async () => {
  const outbox = new InMemoryAuditOutboxStore();
  await enqueueOne(outbox);
  let capturedBatch: AuditBatch | null = null;

  const transport: AuditDeliveryTransport = {
    async sendAuditBatch(_accessToken, batch) {
      capturedBatch = batch;
      return {
        version: "kab.audit-batch-ack.v1",
        batchId: batch.batchId,
        acceptedEventIds: ["unknown-event-id"],
      };
    },
  };

  await assert.rejects(
    () => new AuditDeliveryClient(createSession(), outbox, transport).flushOnce(),
    /was not sent/,
  );
  assert.notEqual(capturedBatch, null);
  assert.equal(await outbox.size(), 1);
});

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FileWebhookEventOutboxStore,
  FileWebhookReplayStore,
  InMemoryWebhookEventOutboxStore,
  InMemoryWebhookReplayStore,
  WebhookAdapter,
  WebhookError,
  type ConnectorSecretProvider,
  type WebhookDefinition,
  type WebhookHttpRequest,
} from "../../src/index.js";

const NOW = new Date("2026-10-13T15:10:00.000Z");
const TIMESTAMP = String(Math.floor(NOW.getTime() / 1000));
const NONCE = "evt-order-0001";
const SECRET = "webhook-super-secret";

const secrets: ConnectorSecretProvider = {
  async getSecret(requirementId, fieldId) {
    if (requirementId === "webhook" && fieldId === "secret") return SECRET;
    if (requirementId === "webhook" && fieldId === "token") return "bearer-token";
    return null;
  },
};

function definition(
  overrides: Partial<WebhookDefinition> = {},
): WebhookDefinition {
  return {
    id: "orders.changed",
    name: "Order changed",
    description: "Receive order-change events from a configured system",
    path: "/webhooks/orders",
    auth: {
      type: "hmac_sha256",
      requirementId: "webhook",
      secretField: "secret",
    },
    redactKeys: ["customerEmail"],
    ...overrides,
  };
}

function body(value: unknown): Uint8Array {
  return Buffer.from(JSON.stringify(value), "utf8");
}

function signature(
  rawBody: Uint8Array,
  timestamp = TIMESTAMP,
  nonce = NONCE,
): string {
  const hmac = createHmac("sha256", SECRET);
  hmac.update(`${timestamp}.${nonce}.`, "utf8");
  hmac.update(rawBody);
  return `sha256=${hmac.digest("hex")}`;
}

function request(
  rawBody: Uint8Array,
  options: {
    timestamp?: string;
    nonce?: string;
    signature?: string;
    headers?: Record<string, string | readonly string[] | undefined>;
  } = {},
): WebhookHttpRequest {
  const timestamp = options.timestamp ?? TIMESTAMP;
  const nonce = options.nonce ?? NONCE;
  return {
    method: "POST",
    path: "/webhooks/orders",
    headers: {
      "content-type": "application/json",
      "x-kairoseth-timestamp": timestamp,
      "x-kairoseth-nonce": nonce,
      "x-kairoseth-signature":
        options.signature ?? signature(rawBody, timestamp, nonce),
      ...options.headers,
    },
    body: rawBody,
  };
}

test("valid HMAC webhook is verified, redacted and emitted once", async () => {
  const replay = new InMemoryWebhookReplayStore();
  const outbox = new InMemoryWebhookEventOutboxStore();
  const adapter = new WebhookAdapter(replay, outbox, { now: () => NOW });
  const rawBody = body({
    orderId: 42,
    token: "remote-token",
    customerEmail: "person@example.test",
    note: `secret echoed: ${SECRET}`,
  });

  const result = await adapter.handle(definition(), request(rawBody), { secrets });

  assert.equal(result.accepted, true);
  assert.equal(result.duplicate, false);

  const events = await outbox.list();
  assert.equal(events.length, 1);
  assert.equal(events[0]?.eventId, result.eventId);
  assert.deepEqual(events[0]?.payload, {
    orderId: 42,
    token: "[REDACTED]",
    customerEmail: "[REDACTED]",
    note: "secret echoed: [REDACTED]",
  });

  const replayRecord = await replay.get("orders.changed", NONCE);
  assert.equal(replayRecord?.payloadFingerprint, events[0]?.payloadFingerprint);
});

test("redelivery of the same authenticated webhook is idempotent", async () => {
  const replay = new InMemoryWebhookReplayStore();
  const outbox = new InMemoryWebhookEventOutboxStore();
  const adapter = new WebhookAdapter(replay, outbox, { now: () => NOW });
  const rawBody = body({ orderId: 42 });
  const first = await adapter.handle(definition(), request(rawBody), { secrets });
  const second = await adapter.handle(definition(), request(rawBody), { secrets });

  assert.equal(first.eventId, second.eventId);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal((await outbox.list()).length, 1);
});

test("same nonce with a different authenticated payload is rejected as a conflict", async () => {
  const replay = new InMemoryWebhookReplayStore();
  const outbox = new InMemoryWebhookEventOutboxStore();
  const adapter = new WebhookAdapter(replay, outbox, { now: () => NOW });

  const firstBody = body({ orderId: 42 });
  const secondBody = body({ orderId: 43 });
  await adapter.handle(definition(), request(firstBody), { secrets });

  await assert.rejects(
    () => adapter.handle(definition(), request(secondBody), { secrets }),
    /conflicts with a different payload fingerprint|conflicts with a different normalized webhook event/,
  );
  assert.equal((await outbox.list()).length, 1);
});

test("tampered body fails HMAC verification before event emission", async () => {
  const replay = new InMemoryWebhookReplayStore();
  const outbox = new InMemoryWebhookEventOutboxStore();
  const adapter = new WebhookAdapter(replay, outbox, { now: () => NOW });

  const original = body({ orderId: 42 });
  const tampered = body({ orderId: 99 });
  const forgedRequest = request(tampered, {
    signature: signature(original),
  });

  await assert.rejects(
    () => adapter.handle(definition(), forgedRequest, { secrets }),
    (error: unknown) =>
      error instanceof WebhookError && error.code === "authentication_failed",
  );
  assert.equal((await outbox.list()).length, 0);
  assert.equal(await replay.get("orders.changed", NONCE), null);
});

test("stale timestamps are rejected before authentication output", async () => {
  const replay = new InMemoryWebhookReplayStore();
  const outbox = new InMemoryWebhookEventOutboxStore();
  const adapter = new WebhookAdapter(replay, outbox, { now: () => NOW });
  const rawBody = body({ orderId: 42 });
  const oldTimestamp = String(Math.floor(NOW.getTime() / 1000) - 301);

  await assert.rejects(
    () =>
      adapter.handle(
        definition(),
        request(rawBody, { timestamp: oldTimestamp }),
        { secrets },
      ),
    (error: unknown) =>
      error instanceof WebhookError && error.code === "timestamp_rejected",
  );
  assert.equal((await outbox.list()).length, 0);
});

test("persistent replay/outbox survive restart and keep redelivery idempotent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kab-webhook-"));
  try {
    const replayPath = join(directory, "replay.json");
    const outboxPath = join(directory, "outbox.json");
    const rawBody = body({ orderId: 42 });

    const firstAdapter = new WebhookAdapter(
      new FileWebhookReplayStore(replayPath),
      new FileWebhookEventOutboxStore(outboxPath),
      { now: () => NOW },
    );
    const first = await firstAdapter.handle(definition(), request(rawBody), {
      secrets,
    });

    const secondOutbox = new FileWebhookEventOutboxStore(outboxPath);
    const secondAdapter = new WebhookAdapter(
      new FileWebhookReplayStore(replayPath),
      secondOutbox,
      { now: () => NOW },
    );
    const second = await secondAdapter.handle(definition(), request(rawBody), {
      secrets,
    });

    assert.equal(first.eventId, second.eventId);
    assert.equal(second.duplicate, true);
    assert.equal((await secondOutbox.list()).length, 1);
    assert.equal(await secondOutbox.acknowledge([first.eventId]), 1);
    assert.equal((await secondOutbox.list()).length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bearer-auth webhook still requires timestamp and nonce replay controls", async () => {
  const outbox = new InMemoryWebhookEventOutboxStore();
  const adapter = new WebhookAdapter(
    new InMemoryWebhookReplayStore(),
    outbox,
    { now: () => NOW },
  );
  const rawBody = body({ status: "paid" });
  const bearerDefinition = definition({
    auth: {
      type: "bearer",
      requirementId: "webhook",
      tokenField: "token",
    },
  });
  const bearerRequest: WebhookHttpRequest = {
    method: "POST",
    path: bearerDefinition.path,
    headers: {
      "content-type": "application/json",
      authorization: "Bearer bearer-token",
      "x-kairoseth-timestamp": TIMESTAMP,
      "x-kairoseth-nonce": "evt-payment-0001",
    },
    body: rawBody,
  };

  const result = await adapter.handle(bearerDefinition, bearerRequest, { secrets });
  assert.equal(result.accepted, true);
  assert.equal((await outbox.list()).length, 1);
});

test("payload size, route and duplicate security headers are rejected", async () => {
  const adapter = new WebhookAdapter(
    new InMemoryWebhookReplayStore(),
    new InMemoryWebhookEventOutboxStore(),
    { now: () => NOW },
  );
  const smallDefinition = definition({ maxBodyBytes: 8 });
  const oversized = body({ long: "0123456789" });

  await assert.rejects(
    () => adapter.handle(smallDefinition, request(oversized), { secrets }),
    (error: unknown) =>
      error instanceof WebhookError && error.code === "payload_too_large",
  );

  const rawBody = body({ ok: true });
  await assert.rejects(
    () =>
      adapter.handle(
        definition(),
        {
          ...request(rawBody),
          path: "/webhooks/other",
        },
        { secrets },
      ),
    (error: unknown) =>
      error instanceof WebhookError && error.code === "invalid_request",
  );

  await assert.rejects(
    () =>
      adapter.handle(
        definition(),
        request(rawBody, {
          headers: {
            "X-Kairoseth-Signature": [signature(rawBody), signature(rawBody)],
          },
        }),
        { secrets },
      ),
    (error: unknown) =>
      error instanceof WebhookError && error.code === "invalid_request",
  );
});

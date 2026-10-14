import assert from "node:assert/strict";
import test from "node:test";

import {
  ControlSession,
  RuntimeSnapshotScheduler,
  type OutboundSessionTransport,
  type RuntimeSnapshotAck,
  type SessionCredential,
} from "../../src/index.js";

const NOW = new Date("2026-10-14T12:45:00.000Z");

const unusedTransport: OutboundSessionTransport = {
  async requestSessionChallenge() {
    throw new Error("unused");
  },
  async openSession() {
    throw new Error("unused");
  },
  async sendHeartbeat() {
    throw new Error("unused");
  },
};

function session(
  sessionId: string,
  accessToken: string,
  expiresAt: string,
): ControlSession {
  const credential: SessionCredential = {
    version: "kab.session-credential.v1",
    sessionId,
    tenantId: "tenant-1",
    installationId: "installation-1",
    bridgeInstanceId: "bridge-1",
    keyId: "key-1",
    accessToken,
    issuedAt: "2026-10-14T12:40:00.000Z",
    expiresAt,
    heartbeatIntervalSeconds: 30,
  };
  return new ControlSession(credential, unusedTransport, {
    runtimeVersion: "0.1.0-dev.0",
    now: () => NOW,
  });
}

function ack(snapshotId: string): RuntimeSnapshotAck {
  return {
    version: "kab.runtime-snapshot-ack.v1",
    snapshotId,
    receivedAt: NOW.toISOString(),
  };
}

test("snapshot scheduler skips safely until a live control session exists", async () => {
  let reports = 0;
  const scheduler = new RuntimeSnapshotScheduler(
    { getCurrentSession: () => null },
    {
      async report() {
        reports += 1;
        return ack("unexpected");
      },
    },
  );

  assert.deepEqual(await scheduler.tick(), {
    reported: false,
    reason: "no_session",
  });
  assert.equal(reports, 0);
});

test("snapshot scheduler does not use an expired session token", async () => {
  let reports = 0;
  const expired = session(
    "session-expired",
    "expired-secret",
    "2026-10-14T12:44:59.000Z",
  );
  const scheduler = new RuntimeSnapshotScheduler(
    { getCurrentSession: () => expired },
    {
      async report() {
        reports += 1;
        return ack("unexpected");
      },
    },
  );

  assert.deepEqual(await scheduler.tick(), {
    reported: false,
    reason: "session_expired",
  });
  assert.equal(reports, 0);
});

test("snapshot scheduler always reads the current session so rotation is picked up without restart", async () => {
  const first = session(
    "session-1",
    "session-token-1",
    "2026-10-14T13:00:00.000Z",
  );
  const second = session(
    "session-2",
    "session-token-2",
    "2026-10-14T13:00:00.000Z",
  );
  let current: ControlSession | null = first;
  const tokens: string[] = [];
  let snapshot = 0;

  const scheduler = new RuntimeSnapshotScheduler(
    { getCurrentSession: () => current },
    {
      async report(accessToken) {
        tokens.push(accessToken);
        snapshot += 1;
        return ack(`snapshot-${snapshot}`);
      },
    },
  );

  const firstResult = await scheduler.tick();
  current = second;
  const secondResult = await scheduler.tick();

  assert.equal(firstResult.reported, true);
  assert.equal(firstResult.sessionId, "session-1");
  assert.equal(secondResult.reported, true);
  assert.equal(secondResult.sessionId, "session-2");
  assert.deepEqual(tokens, ["session-token-1", "session-token-2"]);
});

test("snapshot scheduler retries report failures independently without invalidating the control session", async () => {
  const active = session(
    "session-stable",
    "session-stable-token",
    "2026-10-14T13:00:00.000Z",
  );
  let current: ControlSession | null = active;
  const source = { getCurrentSession: () => current };
  let reports = 0;
  const errors: Array<{ message: string; delay: number }> = [];
  const sleeps: number[] = [];
  const controller = new AbortController();

  const scheduler = new RuntimeSnapshotScheduler(
    source,
    {
      async report() {
        reports += 1;
        if (reports === 1) throw new Error("snapshot endpoint unavailable");
        return ack("snapshot-recovered");
      },
    },
    {
      intervalMs: 10_000,
      retryInitialDelayMs: 1_000,
      retryMaxDelayMs: 8_000,
      retryMultiplier: 2,
      onError(error, delay) {
        errors.push({
          message: error instanceof Error ? error.message : "unknown",
          delay,
        });
      },
      async sleep(delay) {
        sleeps.push(delay);
        if (sleeps.length >= 2) controller.abort();
      },
    },
  );

  await scheduler.run(controller.signal);

  assert.equal(source.getCurrentSession(), active);
  assert.equal(reports, 2);
  assert.deepEqual(errors, [
    { message: "snapshot endpoint unavailable", delay: 1_000 },
  ]);
  assert.deepEqual(sleeps, [1_000, 10_000]);
});

test("snapshot scheduler backoff is bounded and validates unsafe configuration", () => {
  const scheduler = new RuntimeSnapshotScheduler(
    { getCurrentSession: () => null },
    { async report() { return ack("unused"); } },
    {
      retryInitialDelayMs: 1_000,
      retryMaxDelayMs: 4_000,
      retryMultiplier: 2,
    },
  );

  assert.deepEqual(
    [
      scheduler.nextRetryDelayMs(),
      scheduler.nextRetryDelayMs(),
      scheduler.nextRetryDelayMs(),
      scheduler.nextRetryDelayMs(),
    ],
    [1_000, 2_000, 4_000, 4_000],
  );

  assert.throws(
    () =>
      new RuntimeSnapshotScheduler(
        { getCurrentSession: () => null },
        { async report() { return ack("unused"); } },
        { intervalMs: 1_000 },
      ),
    /Invalid runtime snapshot scheduler configuration/,
  );
});

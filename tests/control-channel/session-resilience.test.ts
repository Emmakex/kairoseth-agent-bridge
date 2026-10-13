import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BridgeIdentityManager,
  ControlSessionClient,
  ControlSessionSupervisor,
  FileBridgeIdentityStore,
  FileInstallationBindingStore,
  InMemoryBridgeIdentityStore,
  InMemoryInstallationBindingStore,
  InstallationBindingManager,
  InstallationEnrollmentClient,
  calculateReconnectDelayMs,
  type InstallationBinding,
  type OutboundEnrollmentTransport,
  type OutboundSessionTransport,
  type SessionCredential,
} from "../../src/index.js";

const START = new Date("2026-10-13T14:00:00.000Z");

async function makeIdentityAndBinding(): Promise<{
  identityManager: BridgeIdentityManager;
  bindingManager: InstallationBindingManager;
  binding: InstallationBinding;
}> {
  const identityManager = new BridgeIdentityManager(
    new InMemoryBridgeIdentityStore(),
    () => START,
  );
  const identity = await identityManager.getOrCreate();
  const binding: InstallationBinding = {
    version: "kab.installation-binding.v1",
    tenantId: "tenant-1",
    installationId: "installation-1",
    bridgeInstanceId: identity.bridgeInstanceId,
    keyId: identity.keyId,
    registeredAt: START.toISOString(),
    trustedApprovalKeys: [],
  };
  const store = new InMemoryInstallationBindingStore();
  const bindingManager = new InstallationBindingManager(
    store,
    () => identityManager.getOrCreate(),
  );
  await bindingManager.save(binding);

  return { identityManager, bindingManager, binding };
}

test("filesystem stores preserve identity and binding across manager restarts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kab-state-"));
  const identityPath = join(directory, "identity.json");
  const bindingPath = join(directory, "binding.json");

  try {
    const firstIdentityManager = new BridgeIdentityManager(
      new FileBridgeIdentityStore(identityPath),
      () => START,
    );
    const firstIdentity = await firstIdentityManager.getOrCreate();

    const binding: InstallationBinding = {
      version: "kab.installation-binding.v1",
      tenantId: "tenant-file",
      installationId: "installation-file",
      bridgeInstanceId: firstIdentity.bridgeInstanceId,
      keyId: firstIdentity.keyId,
      registeredAt: START.toISOString(),
      trustedApprovalKeys: [],
    };

    const firstBindingManager = new InstallationBindingManager(
      new FileInstallationBindingStore(bindingPath),
      () => firstIdentityManager.getOrCreate(),
    );
    await firstBindingManager.save(binding);

    const restartedIdentityManager = new BridgeIdentityManager(
      new FileBridgeIdentityStore(identityPath),
    );
    const restartedIdentity = await restartedIdentityManager.getOrCreate();
    const restartedBindingManager = new InstallationBindingManager(
      new FileInstallationBindingStore(bindingPath),
      () => restartedIdentityManager.getOrCreate(),
    );

    assert.equal(restartedIdentity.bridgeInstanceId, firstIdentity.bridgeInstanceId);
    assert.equal(restartedIdentity.keyId, firstIdentity.keyId);
    assert.deepEqual(await restartedBindingManager.require(), binding);

    assert.equal((await stat(identityPath)).mode & 0o777, 0o600);
    assert.equal((await stat(bindingPath)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("successful enrollment persists the authoritative installation binding", async () => {
  const identityManager = new BridgeIdentityManager(new InMemoryBridgeIdentityStore());
  const bindingStore = new InMemoryInstallationBindingStore();
  const identity = await identityManager.getOrCreate();

  const expected: InstallationBinding = {
    version: "kab.installation-binding.v1",
    tenantId: "tenant-enrolled",
    installationId: "installation-enrolled",
    bridgeInstanceId: identity.bridgeInstanceId,
    keyId: identity.keyId,
    registeredAt: START.toISOString(),
    trustedApprovalKeys: [],
  };

  const transport: OutboundEnrollmentTransport = {
    async requestChallenge() {
      return {
        version: "kab.enrollment-challenge.v1",
        nonce: "challenge-1",
        expiresAt: "2026-10-13T14:05:00.000Z",
      };
    },
    async register() {
      return expected;
    },
  };

  const client = new InstallationEnrollmentClient(identityManager, transport, {
    runtimeVersion: "0.1.0",
    deploymentMode: "local",
    bindingStore,
    now: () => START,
  });

  await client.enroll("one-time-token");
  assert.deepEqual(await bindingStore.load(), expected);
});

test("supervisor reuses a healthy session and renews before expiry", async () => {
  const { identityManager, bindingManager, binding } = await makeIdentityAndBinding();
  let currentTime = START.getTime();
  let sessionCounter = 0;

  const transport: OutboundSessionTransport = {
    async requestSessionChallenge() {
      return {
        version: "kab.session-challenge.v1",
        nonce: `nonce-${sessionCounter + 1}`,
        expiresAt: new Date(currentTime + 60_000).toISOString(),
      };
    },
    async openSession() {
      sessionCounter += 1;
      const credential: SessionCredential = {
        version: "kab.session-credential.v1",
        sessionId: `session-${sessionCounter}`,
        tenantId: binding.tenantId,
        installationId: binding.installationId,
        bridgeInstanceId: binding.bridgeInstanceId,
        keyId: binding.keyId,
        accessToken: `secret-${sessionCounter}`,
        issuedAt: new Date(currentTime).toISOString(),
        expiresAt: new Date(currentTime + 120_000).toISOString(),
        heartbeatIntervalSeconds: 15,
      };
      return credential;
    },
    async sendHeartbeat() {
      return {
        version: "kab.heartbeat-ack.v1",
        receivedAt: new Date(currentTime).toISOString(),
      };
    },
  };

  const now = (): Date => new Date(currentTime);
  const sessionClient = new ControlSessionClient(identityManager, transport, {
    runtimeVersion: "0.1.0",
    now,
  });
  const supervisor = new ControlSessionSupervisor(bindingManager, sessionClient, {
    renewBeforeMs: 30_000,
    now,
  });

  const first = await supervisor.tick("ready");
  assert.equal(first.renewed, true);
  assert.equal(first.sessionId, "session-1");

  currentTime += 30_000;
  const second = await supervisor.tick("ready");
  assert.equal(second.renewed, false);
  assert.equal(second.sessionId, "session-1");

  currentTime += 61_000;
  const third = await supervisor.tick("ready");
  assert.equal(third.renewed, true);
  assert.equal(third.sessionId, "session-2");
});

test("reconnect delay grows exponentially, is capped, and supports deterministic jitter", () => {
  const options = {
    initialDelayMs: 1_000,
    maxDelayMs: 5_000,
    multiplier: 2,
    jitterRatio: 0.2,
  };

  assert.equal(calculateReconnectDelayMs(0, options, () => 0.5), 1_000);
  assert.equal(calculateReconnectDelayMs(1, options, () => 0.5), 2_000);
  assert.equal(calculateReconnectDelayMs(2, options, () => 0.5), 4_000);
  assert.equal(calculateReconnectDelayMs(3, options, () => 0.5), 5_000);
  assert.equal(calculateReconnectDelayMs(0, options, () => 0), 800);
  assert.equal(calculateReconnectDelayMs(0, options, () => 1), 1_200);
});

test("run loop backs off after failure and reconnects automatically", async () => {
  const { identityManager, bindingManager, binding } = await makeIdentityAndBinding();
  const controller = new AbortController();
  const sleeps: number[] = [];
  const errors: number[] = [];
  let challengeAttempts = 0;
  let openedSessions = 0;

  const transport: OutboundSessionTransport = {
    async requestSessionChallenge() {
      challengeAttempts += 1;

      if (challengeAttempts === 1) {
        throw new Error("network unavailable");
      }

      return {
        version: "kab.session-challenge.v1",
        nonce: "reconnect-nonce",
        expiresAt: "2026-10-13T14:05:00.000Z",
      };
    },
    async openSession() {
      openedSessions += 1;
      return {
        version: "kab.session-credential.v1",
        sessionId: "session-reconnected",
        tenantId: binding.tenantId,
        installationId: binding.installationId,
        bridgeInstanceId: binding.bridgeInstanceId,
        keyId: binding.keyId,
        accessToken: "session-secret",
        issuedAt: START.toISOString(),
        expiresAt: "2026-10-13T14:10:00.000Z",
        heartbeatIntervalSeconds: 15,
      };
    },
    async sendHeartbeat() {
      return {
        version: "kab.heartbeat-ack.v1",
        receivedAt: START.toISOString(),
        nextHeartbeatInSeconds: 5,
      };
    },
  };

  const sessionClient = new ControlSessionClient(identityManager, transport, {
    runtimeVersion: "0.1.0",
    now: () => START,
  });
  const supervisor = new ControlSessionSupervisor(bindingManager, sessionClient, {
    now: () => START,
    backoff: {
      initialDelayMs: 1_000,
      maxDelayMs: 8_000,
      multiplier: 2,
      jitterRatio: 0,
    },
    sleep: async (delayMs) => {
      sleeps.push(delayMs);
      if (sleeps.length >= 2) {
        controller.abort();
      }
    },
    onError: (_error, retryDelayMs) => {
      errors.push(retryDelayMs);
    },
  });

  await supervisor.run(() => "ready", controller.signal);

  assert.deepEqual(errors, [1_000]);
  assert.deepEqual(sleeps, [1_000, 5_000]);
  assert.equal(challengeAttempts, 2);
  assert.equal(openedSessions, 1);
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  BridgeIdentityManager,
  ControlSessionClient,
  InMemoryBridgeIdentityStore,
  verifySessionProof,
  type HeartbeatPayload,
  type InstallationBinding,
  type OutboundSessionTransport,
  type SessionChallenge,
  type SessionCredential,
  type SignedSessionProof,
} from "../../src/index.js";

const NOW = new Date("2026-10-13T14:10:00.000Z");

function bindingFor(
  bridgeInstanceId: string,
  keyId: string,
): InstallationBinding {
  return {
    version: "kab.installation-binding.v1",
    tenantId: "tenant-1",
    installationId: "installation-1",
    bridgeInstanceId,
    keyId,
    registeredAt: "2026-10-13T14:00:00.000Z",
    trustedApprovalKeys: [],
  };
}

test("opens an action-scoped short-lived session and sends heartbeat metadata", async () => {
  const store = new InMemoryBridgeIdentityStore();
  const manager = new BridgeIdentityManager(store, () => NOW);
  const identity = await manager.getOrCreate();
  const binding = bindingFor(identity.bridgeInstanceId, identity.keyId);
  let heartbeatToken: string | null = null;
  let heartbeatPayload: HeartbeatPayload | null = null;

  const transport: OutboundSessionTransport = {
    async requestSessionChallenge(): Promise<SessionChallenge> {
      return {
        version: "kab.session-challenge.v1",
        nonce: "session-nonce-1",
        expiresAt: "2026-10-13T14:11:00.000Z",
      };
    },
    async openSession(proof: SignedSessionProof): Promise<SessionCredential> {
      assert.equal(proof.payload.tenantId, binding.tenantId);
      assert.equal(proof.payload.installationId, binding.installationId);
      assert.equal(proof.payload.nonce, "session-nonce-1");
      assert.equal(verifySessionProof(proof, identity.publicKeyPem), true);

      return {
        version: "kab.session-credential.v1",
        sessionId: "session-1",
        tenantId: binding.tenantId,
        installationId: binding.installationId,
        bridgeInstanceId: binding.bridgeInstanceId,
        keyId: binding.keyId,
        accessToken: "opaque-session-secret",
        issuedAt: "2026-10-13T14:10:00.000Z",
        expiresAt: "2026-10-13T14:20:00.000Z",
        heartbeatIntervalSeconds: 30,
      };
    },
    async sendHeartbeat(accessToken, heartbeat) {
      heartbeatToken = accessToken;
      heartbeatPayload = heartbeat;
      return {
        version: "kab.heartbeat-ack.v1",
        receivedAt: NOW.toISOString(),
      };
    },
  };

  const client = new ControlSessionClient(manager, transport, {
    runtimeVersion: "0.1.0-dev.0",
    capabilities: ["woocommerce", "files", "woocommerce"],
    now: () => NOW,
  });

  const session = await client.open(binding);
  assert.equal(session.isExpired(), false);

  await session.heartbeat("ready");

  assert.equal(heartbeatToken, "opaque-session-secret");
  assert.equal(heartbeatPayload?.sessionId, "session-1");
  assert.equal(heartbeatPayload?.readiness, "ready");
  assert.deepEqual(heartbeatPayload?.capabilities, ["files", "woocommerce"]);
  assert.equal(JSON.stringify(heartbeatPayload).includes("opaque-session-secret"), false);
});

test("session credential for a different tenant is rejected", async () => {
  const manager = new BridgeIdentityManager(
    new InMemoryBridgeIdentityStore(),
    () => NOW,
  );
  const identity = await manager.getOrCreate();
  const binding = bindingFor(identity.bridgeInstanceId, identity.keyId);

  const transport: OutboundSessionTransport = {
    async requestSessionChallenge() {
      return {
        version: "kab.session-challenge.v1",
        nonce: "nonce",
        expiresAt: "2026-10-13T14:11:00.000Z",
      };
    },
    async openSession() {
      return {
        version: "kab.session-credential.v1",
        sessionId: "session-1",
        tenantId: "tenant-other",
        installationId: binding.installationId,
        bridgeInstanceId: binding.bridgeInstanceId,
        keyId: binding.keyId,
        accessToken: "secret",
        issuedAt: "2026-10-13T14:10:00.000Z",
        expiresAt: "2026-10-13T14:20:00.000Z",
        heartbeatIntervalSeconds: 30,
      };
    },
    async sendHeartbeat() {
      throw new Error("must not heartbeat");
    },
  };

  const client = new ControlSessionClient(manager, transport, {
    runtimeVersion: "0.1.0-dev.0",
    now: () => NOW,
  });

  await assert.rejects(
    () => client.open(binding),
    /scope does not match the installation binding/,
  );
});

test("expired session cannot send heartbeat", async () => {
  let now = new Date("2026-10-13T14:10:00.000Z");
  const manager = new BridgeIdentityManager(
    new InMemoryBridgeIdentityStore(),
    () => now,
  );
  const identity = await manager.getOrCreate();
  const binding = bindingFor(identity.bridgeInstanceId, identity.keyId);

  const transport: OutboundSessionTransport = {
    async requestSessionChallenge() {
      return {
        version: "kab.session-challenge.v1",
        nonce: "nonce",
        expiresAt: "2026-10-13T14:11:00.000Z",
      };
    },
    async openSession() {
      return {
        version: "kab.session-credential.v1",
        sessionId: "session-1",
        tenantId: binding.tenantId,
        installationId: binding.installationId,
        bridgeInstanceId: binding.bridgeInstanceId,
        keyId: binding.keyId,
        accessToken: "secret",
        issuedAt: "2026-10-13T14:10:00.000Z",
        expiresAt: "2026-10-13T14:10:30.000Z",
        heartbeatIntervalSeconds: 10,
      };
    },
    async sendHeartbeat() {
      throw new Error("must not heartbeat");
    },
  };

  const client = new ControlSessionClient(manager, transport, {
    runtimeVersion: "0.1.0-dev.0",
    now: () => now,
  });
  const session = await client.open(binding);

  now = new Date("2026-10-13T14:10:31.000Z");

  await assert.rejects(
    () => session.heartbeat("ready"),
    /credential has expired/,
  );
});

test("tampering with a session proof invalidates its signature", async () => {
  const manager = new BridgeIdentityManager(
    new InMemoryBridgeIdentityStore(),
    () => NOW,
  );
  const identity = await manager.getOrCreate();
  const binding = bindingFor(identity.bridgeInstanceId, identity.keyId);
  let capturedProof: SignedSessionProof | null = null;

  const transport: OutboundSessionTransport = {
    async requestSessionChallenge() {
      return {
        version: "kab.session-challenge.v1",
        nonce: "nonce",
        expiresAt: "2026-10-13T14:11:00.000Z",
      };
    },
    async openSession(proof) {
      capturedProof = proof;
      return {
        version: "kab.session-credential.v1",
        sessionId: "session-1",
        tenantId: binding.tenantId,
        installationId: binding.installationId,
        bridgeInstanceId: binding.bridgeInstanceId,
        keyId: binding.keyId,
        accessToken: "secret",
        issuedAt: "2026-10-13T14:10:00.000Z",
        expiresAt: "2026-10-13T14:20:00.000Z",
        heartbeatIntervalSeconds: 30,
      };
    },
    async sendHeartbeat() {
      return {
        version: "kab.heartbeat-ack.v1",
        receivedAt: NOW.toISOString(),
      };
    },
  };

  await new ControlSessionClient(manager, transport, {
    runtimeVersion: "0.1.0-dev.0",
    now: () => NOW,
  }).open(binding);

  assert.ok(capturedProof);
  const tampered: SignedSessionProof = {
    ...capturedProof,
    payload: {
      ...capturedProof.payload,
      installationId: "installation-other",
    },
  };

  assert.equal(verifySessionProof(tampered, identity.publicKeyPem), false);
});

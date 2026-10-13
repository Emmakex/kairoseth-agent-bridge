import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import {
  ApprovalKeySetManager,
  ApprovalKeySetSyncClient,
  ControlSession,
  InMemoryApprovalKeySetStore,
  canonicalJson,
  type ApprovalKeySetPayload,
  type ApprovalKeySetTransport,
  type InstallationBinding,
  type OutboundSessionTransport,
  type SessionCredential,
  type SignedApprovalKeySet,
} from "../../src/index.js";

const NOW = new Date("2026-10-13T15:00:00.000Z");
const oldPair = generateKeyPairSync("ed25519");
const newPair = generateKeyPairSync("ed25519");

const binding: InstallationBinding = {
  version: "kab.installation-binding.v1",
  tenantId: "tenant-1",
  installationId: "installation-1",
  bridgeInstanceId: "bridge-1",
  keyId: "bridge-key-1",
  registeredAt: "2026-10-13T14:00:00.000Z",
  trustedApprovalKeys: [
    {
      keyId: "approval-old",
      publicKeyPem: oldPair.publicKey
        .export({ format: "pem", type: "spki" })
        .toString(),
    },
  ],
};

const credential: SessionCredential = {
  version: "kab.session-credential.v1",
  sessionId: "session-1",
  tenantId: binding.tenantId,
  installationId: binding.installationId,
  bridgeInstanceId: binding.bridgeInstanceId,
  keyId: binding.keyId,
  accessToken: "session-secret",
  issuedAt: "2026-10-13T14:59:00.000Z",
  expiresAt: "2026-10-13T15:30:00.000Z",
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

function signedUpdate(): SignedApprovalKeySet {
  const payload: ApprovalKeySetPayload = {
    version: "kab.approval-keyset.v1",
    tenantId: binding.tenantId,
    installationId: binding.installationId,
    bridgeInstanceId: binding.bridgeInstanceId,
    generation: 1,
    keys: [
      binding.trustedApprovalKeys[0]!,
      {
        keyId: "approval-new",
        publicKeyPem: newPair.publicKey
          .export({ format: "pem", type: "spki" })
          .toString(),
      },
    ],
    issuedAt: NOW.toISOString(),
  };

  return {
    payload,
    signerKeyId: "approval-old",
    signature: sign(
      null,
      Buffer.from(canonicalJson(payload), "utf8"),
      oldPair.privateKey,
    ).toString("base64url"),
  };
}

test("sync client authenticates with the active session and applies a signed keyset", async () => {
  const manager = new ApprovalKeySetManager(
    binding,
    new InMemoryApprovalKeySetStore(),
    { now: () => NOW },
  );
  const calls: Array<{
    accessToken: string;
    sessionId: string;
    generation: number;
  }> = [];

  const transport: ApprovalKeySetTransport = {
    async fetchApprovalKeySet(accessToken, sessionId, currentGeneration) {
      calls.push({
        accessToken,
        sessionId,
        generation: currentGeneration,
      });
      return signedUpdate();
    },
  };

  const result = await new ApprovalKeySetSyncClient(
    createSession(),
    manager,
    transport,
  ).syncOnce();

  assert.deepEqual(calls, [
    {
      accessToken: credential.accessToken,
      sessionId: credential.sessionId,
      generation: 0,
    },
  ]);
  assert.deepEqual(result, { changed: true, generation: 1 });
  assert.notEqual(await manager.resolvePublicKey("approval-new"), null);
});

test("sync client reports no change when Platform has no newer generation", async () => {
  const manager = new ApprovalKeySetManager(
    binding,
    new InMemoryApprovalKeySetStore(),
    { now: () => NOW },
  );
  const transport: ApprovalKeySetTransport = {
    async fetchApprovalKeySet() {
      return null;
    },
  };

  const result = await new ApprovalKeySetSyncClient(
    createSession(),
    manager,
    transport,
  ).syncOnce();

  assert.deepEqual(result, { changed: false, generation: 0 });
});

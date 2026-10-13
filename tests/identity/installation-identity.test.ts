import assert from "node:assert/strict";
import test from "node:test";

import {
  BridgeIdentityManager,
  InMemoryBridgeIdentityStore,
  createRegistrationProof,
  getBridgePublicKeyFingerprint,
  toPublicBridgeIdentity,
  verifyRegistrationProof,
} from "../../src/index.js";

const NOW = new Date("2026-10-13T14:00:00.000Z");

test("bridge identity remains stable when loaded from the same store", async () => {
  const store = new InMemoryBridgeIdentityStore();
  const manager = new BridgeIdentityManager(store, () => NOW);

  const first = await manager.getOrCreate();
  const second = await manager.getOrCreate();

  assert.equal(first.bridgeInstanceId, second.bridgeInstanceId);
  assert.equal(first.keyId, second.keyId);
  assert.equal(first.publicKeyPem, second.publicKeyPem);
  assert.equal(first.privateKeyPem, second.privateKeyPem);
  assert.equal(first.createdAt, NOW.toISOString());
  assert.equal(getBridgePublicKeyFingerprint(first.publicKeyPem), first.keyId);
});

test("public bridge identity never exposes the private key", async () => {
  const identity = await new BridgeIdentityManager(
    new InMemoryBridgeIdentityStore(),
    () => NOW,
  ).getOrCreate();

  const publicIdentity = toPublicBridgeIdentity(identity);

  assert.equal("privateKeyPem" in publicIdentity, false);
  assert.equal(publicIdentity.bridgeInstanceId, identity.bridgeInstanceId);
  assert.equal(publicIdentity.keyId, identity.keyId);
});

test("registration proof proves key possession and detects tampering", async () => {
  const identity = await new BridgeIdentityManager(
    new InMemoryBridgeIdentityStore(),
    () => NOW,
  ).getOrCreate();

  const proof = createRegistrationProof(identity, {
    runtimeVersion: "0.1.0-dev.0",
    deploymentMode: "local",
    capabilities: ["woocommerce", "files", "woocommerce"],
    nonce: "challenge-123",
    now: () => NOW,
  });

  assert.equal(verifyRegistrationProof(proof).valid, true);
  assert.deepEqual(proof.payload.capabilities, ["files", "woocommerce"]);
  assert.equal(JSON.stringify(proof).includes("PRIVATE KEY"), false);

  const tampered = {
    ...proof,
    payload: {
      ...proof.payload,
      deploymentMode: "hosted" as const,
    },
  };

  assert.deepEqual(verifyRegistrationProof(tampered), {
    valid: false,
    reason: "Registration proof signature is invalid.",
  });
});

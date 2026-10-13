import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ApprovalKeySetManager,
  FileApprovalKeySetStore,
  InMemoryApprovalKeySetStore,
  canonicalJson,
  type ApprovalKeySetPayload,
  type InstallationBinding,
  type SignedApprovalKeySet,
  type TrustedApprovalKey,
} from "../../src/index.js";

const NOW = new Date("2026-10-13T15:00:00.000Z");

function makeKey(keyId: string): {
  trusted: TrustedApprovalKey;
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"];
} {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey,
    trusted: {
      keyId,
      publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
    },
  };
}

const oldKey = makeKey("approval-key-old");
const newKey = makeKey("approval-key-new");
const attackerKey = makeKey("approval-key-attacker");

const binding: InstallationBinding = {
  version: "kab.installation-binding.v1",
  tenantId: "tenant-1",
  installationId: "installation-1",
  bridgeInstanceId: "bridge-1",
  keyId: "bridge-identity-key",
  registeredAt: "2026-10-13T14:00:00.000Z",
  trustedApprovalKeys: [oldKey.trusted],
};

function payload(
  generation: number,
  keys: readonly TrustedApprovalKey[],
): ApprovalKeySetPayload {
  return {
    version: "kab.approval-keyset.v1",
    tenantId: binding.tenantId,
    installationId: binding.installationId,
    bridgeInstanceId: binding.bridgeInstanceId,
    generation,
    keys,
    issuedAt: NOW.toISOString(),
  };
}

function signed(
  value: ApprovalKeySetPayload,
  signerKeyId: string,
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
): SignedApprovalKeySet {
  return {
    payload: value,
    signerKeyId,
    signature: sign(
      null,
      Buffer.from(canonicalJson(value), "utf8"),
      privateKey,
    ).toString("base64url"),
  };
}

test("binding keys bootstrap generation zero and resolve active public keys", async () => {
  const manager = new ApprovalKeySetManager(
    binding,
    new InMemoryApprovalKeySetStore(),
    { now: () => NOW },
  );

  const state = await manager.getOrBootstrap();

  assert.equal(state.generation, 0);
  assert.equal(state.keys.length, 1);
  assert.equal(await manager.resolvePublicKey(oldKey.trusted.keyId), oldKey.trusted.publicKeyPem);
  assert.equal(await manager.resolvePublicKey("unknown"), null);
});

test("trusted old key can introduce a new key and new key can later retire old key", async () => {
  const manager = new ApprovalKeySetManager(
    binding,
    new InMemoryApprovalKeySetStore(),
    { now: () => NOW },
  );

  const generation1 = signed(
    payload(1, [oldKey.trusted, newKey.trusted]),
    oldKey.trusted.keyId,
    oldKey.privateKey,
  );
  const state1 = await manager.apply(generation1);

  assert.equal(state1.generation, 1);
  assert.equal(await manager.resolvePublicKey(newKey.trusted.keyId), newKey.trusted.publicKeyPem);

  const generation2 = signed(
    payload(2, [newKey.trusted]),
    newKey.trusted.keyId,
    newKey.privateKey,
  );
  const state2 = await manager.apply(generation2);

  assert.equal(state2.generation, 2);
  assert.equal(await manager.resolvePublicKey(oldKey.trusted.keyId), null);
  assert.equal(await manager.resolvePublicKey(newKey.trusted.keyId), newKey.trusted.publicKeyPem);
});

test("untrusted signer cannot replace the approval keyset", async () => {
  const manager = new ApprovalKeySetManager(
    binding,
    new InMemoryApprovalKeySetStore(),
    { now: () => NOW },
  );

  await assert.rejects(
    () =>
      manager.apply(
        signed(
          payload(1, [attackerKey.trusted]),
          attackerKey.trusted.keyId,
          attackerKey.privateKey,
        ),
      ),
    /signer is not currently trusted/,
  );
});

test("rollback generation is rejected", async () => {
  const manager = new ApprovalKeySetManager(
    binding,
    new InMemoryApprovalKeySetStore(),
    { now: () => NOW },
  );

  await manager.apply(
    signed(
      payload(2, [oldKey.trusted, newKey.trusted]),
      oldKey.trusted.keyId,
      oldKey.privateKey,
    ),
  );

  await assert.rejects(
    () =>
      manager.apply(
        signed(payload(1, [oldKey.trusted]), oldKey.trusted.keyId, oldKey.privateKey),
      ),
    /generation is not newer/,
  );
});

test("invalid signature is rejected even when signer key ID is trusted", async () => {
  const manager = new ApprovalKeySetManager(
    binding,
    new InMemoryApprovalKeySetStore(),
    { now: () => NOW },
  );
  const forged = signed(
    payload(1, [oldKey.trusted, newKey.trusted]),
    oldKey.trusted.keyId,
    attackerKey.privateKey,
  );

  await assert.rejects(() => manager.apply(forged), /signature is invalid/);
});

test("persisted keyset survives restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kab-keyset-"));
  const filePath = join(directory, "approval-keys.json");

  try {
    const manager = new ApprovalKeySetManager(
      binding,
      new FileApprovalKeySetStore(filePath),
      { now: () => NOW },
    );

    await manager.apply(
      signed(
        payload(1, [oldKey.trusted, newKey.trusted]),
        oldKey.trusted.keyId,
        oldKey.privateKey,
      ),
    );

    const restarted = new ApprovalKeySetManager(
      binding,
      new FileApprovalKeySetStore(filePath),
      { now: () => NOW },
    );
    const state = await restarted.getOrBootstrap();

    assert.equal(state.generation, 1);
    assert.equal(await restarted.resolvePublicKey(newKey.trusted.keyId), newKey.trusted.publicKeyPem);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("keyset cannot remove every currently active key", async () => {
  const manager = new ApprovalKeySetManager(
    binding,
    new InMemoryApprovalKeySetStore(),
    { now: () => NOW },
  );
  const futureKey: TrustedApprovalKey = {
    ...newKey.trusted,
    notBefore: "2026-10-14T15:00:00.000Z",
  };

  await assert.rejects(
    () =>
      manager.apply(
        signed(payload(1, [futureKey]), oldKey.trusted.keyId, oldKey.privateKey),
      ),
    /without an active approval key/,
  );
});

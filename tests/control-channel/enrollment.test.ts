import assert from "node:assert/strict";
import test from "node:test";

import {
  BridgeIdentityManager,
  InMemoryBridgeIdentityStore,
  InstallationEnrollmentClient,
  verifyRegistrationProof,
  type EnrollmentChallenge,
  type InstallationBinding,
  type OutboundEnrollmentTransport,
  type SignedRegistrationProof,
} from "../../src/index.js";

const NOW = new Date("2026-10-13T14:00:00.000Z");

class FakeEnrollmentTransport implements OutboundEnrollmentTransport {
  readonly seenTokens: string[] = [];
  lastProof: SignedRegistrationProof | null = null;

  async requestChallenge(enrollmentToken: string): Promise<EnrollmentChallenge> {
    this.seenTokens.push(enrollmentToken);
    return {
      version: "kab.enrollment-challenge.v1",
      nonce: "server-nonce-1",
      expiresAt: "2026-10-13T14:05:00.000Z",
    };
  }

  async register(
    enrollmentToken: string,
    proof: SignedRegistrationProof,
  ): Promise<InstallationBinding> {
    this.seenTokens.push(enrollmentToken);
    this.lastProof = proof;

    const verification = verifyRegistrationProof(proof);
    assert.equal(verification.valid, true);

    return {
      version: "kab.installation-binding.v1",
      tenantId: "tenant-platform-assigned",
      installationId: "installation-platform-assigned",
      bridgeInstanceId: proof.payload.bridgeInstanceId,
      keyId: proof.payload.keyId,
      registeredAt: NOW.toISOString(),
      trustedApprovalKeys: [],
    };
  }
}

test("runtime enrolls through a server challenge and platform-assigned binding", async () => {
  const transport = new FakeEnrollmentTransport();
  const manager = new BridgeIdentityManager(
    new InMemoryBridgeIdentityStore(),
    () => NOW,
  );
  const client = new InstallationEnrollmentClient(manager, transport, {
    runtimeVersion: "0.1.0-dev.0",
    deploymentMode: "local",
    capabilities: ["files", "woocommerce"],
    now: () => NOW,
  });

  const binding = await client.enroll("one-time-enrollment-token");

  assert.equal(binding.tenantId, "tenant-platform-assigned");
  assert.equal(binding.installationId, "installation-platform-assigned");
  assert.deepEqual(transport.seenTokens, [
    "one-time-enrollment-token",
    "one-time-enrollment-token",
  ]);
  assert.equal(transport.lastProof?.payload.nonce, "server-nonce-1");
  assert.equal(transport.lastProof?.payload.deploymentMode, "local");
});

test("expired enrollment challenge is rejected before registration", async () => {
  let registerCalled = false;

  const transport: OutboundEnrollmentTransport = {
    async requestChallenge() {
      return {
        version: "kab.enrollment-challenge.v1",
        nonce: "expired-nonce",
        expiresAt: "2026-10-13T13:59:59.000Z",
      };
    },
    async register() {
      registerCalled = true;
      throw new Error("must not register");
    },
  };

  const client = new InstallationEnrollmentClient(
    new BridgeIdentityManager(new InMemoryBridgeIdentityStore(), () => NOW),
    transport,
    {
      runtimeVersion: "0.1.0-dev.0",
      deploymentMode: "local",
      now: () => NOW,
    },
  );

  await assert.rejects(
    () => client.enroll("token"),
    /Enrollment challenge has expired/,
  );
  assert.equal(registerCalled, false);
});

test("binding for another bridge instance is rejected", async () => {
  const transport: OutboundEnrollmentTransport = {
    async requestChallenge() {
      return {
        version: "kab.enrollment-challenge.v1",
        nonce: "nonce-1",
        expiresAt: "2026-10-13T14:05:00.000Z",
      };
    },
    async register(_token, proof) {
      return {
        version: "kab.installation-binding.v1",
        tenantId: "tenant-1",
        installationId: "installation-1",
        bridgeInstanceId: `${proof.payload.bridgeInstanceId}-other`,
        keyId: proof.payload.keyId,
        registeredAt: NOW.toISOString(),
        trustedApprovalKeys: [],
      };
    },
  };

  const client = new InstallationEnrollmentClient(
    new BridgeIdentityManager(new InMemoryBridgeIdentityStore(), () => NOW),
    transport,
    {
      runtimeVersion: "0.1.0-dev.0",
      deploymentMode: "local",
      now: () => NOW,
    },
  );

  await assert.rejects(
    () => client.enroll("token"),
    /different bridge instance/,
  );
});

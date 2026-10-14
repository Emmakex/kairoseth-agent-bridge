import assert from "node:assert/strict";
import test from "node:test";

import {
  EnrollmentTransportError,
  HttpEnrollmentTransport,
  type SignedRegistrationProof,
} from "../../src/index.js";

const proof: SignedRegistrationProof = {
  payload: {
    version: "kab.registration.v1",
    bridgeInstanceId: "bridge-1",
    keyId: "key-1",
    publicKeyPem: "-----BEGIN PUBLIC KEY-----\nTEST\n-----END PUBLIC KEY-----\n",
    runtimeVersion: "0.1.0-dev.0",
    deploymentMode: "local",
    capabilities: ["files"],
    nonce: "nonce-1",
    issuedAt: "2026-10-14T10:00:00.000Z",
  },
  signature: "signature-1",
};

test("HTTP enrollment transport sends the token only in Authorization and maps Platform responses", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), init });

    if (String(input).endsWith("/challenge")) {
      return new Response(
        JSON.stringify({
          version: "kab.enrollment-challenge.v1",
          nonce: "nonce-1",
          expiresAt: "2026-10-14T10:05:00.000Z",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({
        binding: {
          version: "kab.installation-binding.v1",
          tenantId: "tenant-1",
          installationId: "installation-1",
          bridgeInstanceId: "bridge-1",
          keyId: "key-1",
          registeredAt: "2026-10-14T10:00:01.000Z",
          trustedApprovalKeys: [],
        },
      }),
      { status: 201, headers: { "Content-Type": "application/json" } },
    );
  };

  const transport = new HttpEnrollmentTransport({
    baseUrl: "https://kairoseth.example",
    fetch: fetchImpl,
  });

  const challenge = await transport.requestChallenge("secret-token");
  const binding = await transport.register("secret-token", proof);

  assert.equal(challenge.nonce, "nonce-1");
  assert.equal(binding.installationId, "installation-1");
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.url.includes("secret-token"), false);
  assert.equal(requests[1]?.url.includes("secret-token"), false);

  for (const request of requests) {
    const headers = new Headers(request.init?.headers);
    assert.equal(headers.get("authorization"), "Bearer secret-token");
    assert.equal(request.init?.redirect, "error");
    assert.equal(request.init?.cache, "no-store");
  }

  assert.deepEqual(JSON.parse(String(requests[1]?.init?.body)), { proof });
});

test("HTTP enrollment transport rejects insecure remote HTTP by default but permits localhost", () => {
  assert.throws(
    () =>
      new HttpEnrollmentTransport({
        baseUrl: "http://customer.example",
      }),
    /requires HTTPS/,
  );

  assert.doesNotThrow(
    () =>
      new HttpEnrollmentTransport({
        baseUrl: "http://127.0.0.1:3000",
      }),
  );
});

test("Platform rejection exposes bounded code/status without leaking enrollment token or response error text", async () => {
  const token = "top-secret-enrollment-token";
  const transport = new HttpEnrollmentTransport({
    baseUrl: "https://kairoseth.example",
    fetch: async () =>
      new Response(
        JSON.stringify({
          code: "invalid_or_expired_enrollment",
          error: `do not expose ${token}`,
        }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      ),
  });

  await assert.rejects(
    () => transport.requestChallenge(token),
    (error: unknown) => {
      assert.ok(error instanceof EnrollmentTransportError);
      assert.equal(error.status, 401);
      assert.equal(error.code, "invalid_or_expired_enrollment");
      assert.equal(error.message.includes(token), false);
      assert.equal(error.message.includes("do not expose"), false);
      return true;
    },
  );
});

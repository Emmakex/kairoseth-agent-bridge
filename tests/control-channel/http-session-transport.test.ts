import assert from "node:assert/strict";
import test from "node:test";

import {
  HttpSessionTransport,
  SessionTransportError,
  type HeartbeatPayload,
  type InstallationBinding,
  type SignedSessionProof,
} from "../../src/index.js";

const binding: InstallationBinding = {
  version: "kab.installation-binding.v1",
  tenantId: "tenant-1",
  installationId: "installation-1",
  bridgeInstanceId: "bridge-1",
  keyId: "key-1",
  registeredAt: "2026-10-14T10:00:00.000Z",
  trustedApprovalKeys: [],
};

const proof: SignedSessionProof = {
  payload: {
    version: "kab.session-proof.v1",
    tenantId: "tenant-1",
    installationId: "installation-1",
    bridgeInstanceId: "bridge-1",
    keyId: "key-1",
    nonce: "nonce-1",
    issuedAt: "2026-10-14T10:01:00.000Z",
  },
  signature: "signature-1",
};

const heartbeat: HeartbeatPayload = {
  version: "kab.heartbeat.v1",
  sessionId: "session-1",
  tenantId: "tenant-1",
  installationId: "installation-1",
  bridgeInstanceId: "bridge-1",
  sentAt: "2026-10-14T10:02:00.000Z",
  readiness: "ready",
  runtimeVersion: "0.1.0-dev.0",
  capabilities: ["files", "woocommerce"],
};

test("HTTP session transport maps challenge, credential and heartbeat without leaking access token", async () => {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, init });

    if (url.endsWith("/challenge")) {
      return new Response(
        JSON.stringify({
          version: "kab.session-challenge.v1",
          nonce: "nonce-1",
          expiresAt: "2026-10-14T10:06:00.000Z",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.endsWith("/open")) {
      return new Response(
        JSON.stringify({
          credential: {
            version: "kab.session-credential.v1",
            sessionId: "session-1",
            tenantId: "tenant-1",
            installationId: "installation-1",
            bridgeInstanceId: "bridge-1",
            keyId: "key-1",
            accessToken: "runtime-session-secret",
            issuedAt: "2026-10-14T10:01:00.000Z",
            expiresAt: "2026-10-14T10:16:00.000Z",
            heartbeatIntervalSeconds: 30,
          },
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        ack: {
          version: "kab.heartbeat-ack.v1",
          receivedAt: "2026-10-14T10:02:01.000Z",
          nextHeartbeatInSeconds: 30,
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  const transport = new HttpSessionTransport({
    baseUrl: "https://kairoseth.example",
    fetch: fetchImpl,
  });

  const challenge = await transport.requestSessionChallenge(binding);
  const credential = await transport.openSession(proof);
  const ack = await transport.sendHeartbeat("runtime-session-secret", heartbeat);

  assert.equal(challenge.nonce, "nonce-1");
  assert.equal(credential.sessionId, "session-1");
  assert.equal(ack.nextHeartbeatInSeconds, 30);
  assert.equal(requests.length, 3);

  const challengeBody = JSON.parse(String(requests[0]?.init?.body));
  assert.deepEqual(challengeBody, {
    tenantId: binding.tenantId,
    installationId: binding.installationId,
    bridgeInstanceId: binding.bridgeInstanceId,
    keyId: binding.keyId,
  });
  assert.deepEqual(JSON.parse(String(requests[1]?.init?.body)), { proof });
  assert.deepEqual(JSON.parse(String(requests[2]?.init?.body)), { heartbeat });

  for (const request of requests) {
    assert.equal(request.url.includes("runtime-session-secret"), false);
    assert.equal(request.init?.redirect, "error");
    assert.equal(request.init?.cache, "no-store");
  }
  assert.equal(
    new Headers(requests[2]?.init?.headers).get("authorization"),
    "Bearer runtime-session-secret",
  );
  assert.equal(String(requests[2]?.init?.body).includes("runtime-session-secret"), false);
});

test("HTTP session transport requires HTTPS outside localhost", () => {
  assert.throws(
    () => new HttpSessionTransport({ baseUrl: "http://customer.example" }),
    /requires HTTPS/,
  );
  assert.doesNotThrow(
    () => new HttpSessionTransport({ baseUrl: "http://localhost:3000" }),
  );
});

test("session transport errors expose bounded status/code without raw response or access token", async () => {
  const token = "runtime-session-secret";
  const transport = new HttpSessionTransport({
    baseUrl: "https://kairoseth.example",
    fetch: async () =>
      new Response(
        JSON.stringify({
          code: "invalid_or_expired_session",
          error: `do not expose ${token}`,
        }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      ),
  });

  await assert.rejects(
    () => transport.sendHeartbeat(token, heartbeat),
    (error: unknown) => {
      assert.ok(error instanceof SessionTransportError);
      assert.equal(error.status, 401);
      assert.equal(error.code, "invalid_or_expired_session");
      assert.equal(error.message.includes(token), false);
      assert.equal(error.message.includes("do not expose"), false);
      return true;
    },
  );
});

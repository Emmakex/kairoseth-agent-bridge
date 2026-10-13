import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import {
  BridgeRuntime,
  InMemoryApprovalReplayStore,
  SignedApprovalPolicyEvaluator,
  SignedApprovalVerifier,
  ToolRegistry,
  canonicalJson,
  createActionFingerprint,
  type ApprovalPayload,
} from "../../src/index.js";

const NOW = new Date("2026-10-13T13:30:00.000Z");
const KEY_ID = "platform-key-1";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const publicKeyPem = publicKey
  .export({ format: "pem", type: "spki" })
  .toString();

function createToken(payload: ApprovalPayload): string {
  const keyIdSegment = Buffer.from(KEY_ID, "utf8").toString("base64url");
  const payloadSegment = Buffer.from(canonicalJson(payload), "utf8").toString(
    "base64url",
  );
  const signingInput = `kab1.${keyIdSegment}.${payloadSegment}`;
  const signature = sign(null, Buffer.from(signingInput, "utf8"), privateKey);

  return `${signingInput}.${signature.toString("base64url")}`;
}

function makePayload(
  input: unknown,
  decision: ApprovalPayload["decision"] = "ALLOW",
): ApprovalPayload {
  const request = {
    tenantId: "tenant-1",
    installationId: "installation-1",
    toolId: "orders.update",
    correlationId: "corr-1",
    input,
  };

  return {
    version: "kab.approval.v1",
    decision,
    tenantId: request.tenantId,
    installationId: request.installationId,
    toolId: request.toolId,
    correlationId: request.correlationId,
    actionFingerprint: createActionFingerprint(request),
    issuedAt: "2026-10-13T13:29:00.000Z",
    expiresAt: "2026-10-13T13:31:00.000Z",
    nonce: "nonce-1",
  };
}

function createVerifier(): SignedApprovalVerifier {
  return new SignedApprovalVerifier({
    now: () => NOW,
    resolvePublicKey: async (keyId) =>
      keyId === KEY_ID ? publicKeyPem : null,
  });
}

function createPolicy(
  replayStore = new InMemoryApprovalReplayStore(),
): SignedApprovalPolicyEvaluator {
  return new SignedApprovalPolicyEvaluator(createVerifier(), {
    replayStore,
    now: () => NOW,
  });
}

test("valid signed approval is accepted for the exact action", async () => {
  const input = { orderId: 42, status: "processing" };
  const payload = makePayload(input);
  const verifier = createVerifier();

  const result = await verifier.verify(createToken(payload), {
    tenantId: payload.tenantId,
    installationId: payload.installationId,
    toolId: payload.toolId,
    correlationId: payload.correlationId,
    input,
  });

  assert.equal(result.valid, true);
  if (result.valid) {
    assert.equal(result.decision, "ALLOW");
  }
});

test("signed approval cannot be reused for a modified payload", async () => {
  const approvedInput = { orderId: 42, status: "processing" };
  const verifier = createVerifier();

  const result = await verifier.verify(createToken(makePayload(approvedInput)), {
    tenantId: "tenant-1",
    installationId: "installation-1",
    toolId: "orders.update",
    correlationId: "corr-1",
    input: { orderId: 42, status: "cancelled" },
  });

  assert.deepEqual(result, {
    valid: false,
    reason: "Approval fingerprint does not match the requested action.",
  });
});

test("expired approval is rejected", async () => {
  const input = { orderId: 42 };
  const payload: ApprovalPayload = {
    ...makePayload(input),
    issuedAt: "2026-10-13T13:20:00.000Z",
    expiresAt: "2026-10-13T13:21:00.000Z",
  };

  const result = await createVerifier().verify(createToken(payload), {
    tenantId: payload.tenantId,
    installationId: payload.installationId,
    toolId: payload.toolId,
    correlationId: payload.correlationId,
    input,
  });

  assert.deepEqual(result, {
    valid: false,
    reason: "Approval has expired.",
  });
});

test("WRITE execution requires a matching signed approval and consumes it once", async () => {
  const registry = new ToolRegistry();
  const policy = createPolicy();
  let executions = 0;

  registry.register({
    id: "orders.update",
    name: "Update order",
    description: "Update an order",
    risk: "WRITE",
    async execute(input) {
      executions += 1;
      return input;
    },
  });

  const runtime = new BridgeRuntime({ registry, policy });
  const approvedInput = { orderId: 42, status: "processing" };
  const approvalToken = createToken(makePayload(approvedInput));
  const context = {
    correlationId: "corr-1",
    actor: "agent-1",
    tenantId: "tenant-1",
    installationId: "installation-1",
    approvalToken,
  };

  const tampered = await runtime.invoke(
    "orders.update",
    { orderId: 42, status: "cancelled" },
    context,
  );

  assert.equal(tampered.status, "denied");
  assert.equal(executions, 0);

  const approved = await runtime.invoke("orders.update", approvedInput, context);

  assert.equal(approved.status, "executed");
  assert.equal(executions, 1);

  const replayed = await runtime.invoke("orders.update", approvedInput, context);

  assert.equal(replayed.status, "denied");
  if (replayed.status === "denied") {
    assert.match(replayed.reason, /already been consumed/);
  }
  assert.equal(executions, 1);
});

test("explicit signed DENY remains denied without consuming execution permission", async () => {
  const input = { orderId: 42, status: "processing" };
  const registry = new ToolRegistry();
  const policy = createPolicy();

  registry.register({
    id: "orders.update",
    name: "Update order",
    description: "Update an order",
    risk: "WRITE",
    async execute() {
      throw new Error("must not execute");
    },
  });

  const result = await new BridgeRuntime({ registry, policy }).invoke(
    "orders.update",
    input,
    {
      correlationId: "corr-1",
      actor: "agent-1",
      tenantId: "tenant-1",
      installationId: "installation-1",
      approvalToken: createToken(makePayload(input, "DENY")),
    },
  );

  assert.equal(result.status, "denied");
});

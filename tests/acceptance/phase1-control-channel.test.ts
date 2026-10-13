import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import {
  ApprovalKeySetManager,
  AuditDeliveryClient,
  BridgeIdentityManager,
  BridgeRuntime,
  CommandProcessor,
  ControlSessionClient,
  InMemoryApprovalKeySetStore,
  InMemoryApprovalReplayStore,
  InMemoryAuditOutboxStore,
  InMemoryBridgeIdentityStore,
  InMemoryCommandReceiptStore,
  InMemoryInstallationBindingStore,
  InstallationEnrollmentClient,
  SanitizedAuditSink,
  SignedApprovalPolicyEvaluator,
  SignedApprovalVerifier,
  ToolRegistry,
  canonicalJson,
  createActionFingerprint,
  verifyRegistrationProof,
  verifySessionProof,
  type ApprovalPayload,
  type AuditBatch,
  type AuditDeliveryTransport,
  type InstallationBinding,
  type OutboundEnrollmentTransport,
  type OutboundSessionTransport,
  type SessionCredential,
  type SignedRegistrationProof,
  type SignedSessionProof,
} from "../../src/index.js";

const NOW = new Date("2026-10-13T16:00:00.000Z");
const approvalPair = generateKeyPairSync("ed25519");
const APPROVAL_KEY_ID = "platform-approval-key-1";

function createApprovalToken(payload: ApprovalPayload): string {
  const keyIdSegment = Buffer.from(APPROVAL_KEY_ID, "utf8").toString("base64url");
  const payloadSegment = Buffer.from(canonicalJson(payload), "utf8").toString(
    "base64url",
  );
  const signingInput = `kab1.${keyIdSegment}.${payloadSegment}`;
  const signature = sign(
    null,
    Buffer.from(signingInput, "utf8"),
    approvalPair.privateKey,
  );
  return `${signingInput}.${signature.toString("base64url")}`;
}

test("Phase 1: enrolled runtime opens session, executes approved WRITE once, and delivers sanitized audit", async () => {
  const identityManager = new BridgeIdentityManager(
    new InMemoryBridgeIdentityStore(),
    () => NOW,
  );
  const bindingStore = new InMemoryInstallationBindingStore();
  let registrationProofVerified = false;

  const enrollmentTransport: OutboundEnrollmentTransport = {
    async requestChallenge() {
      return {
        version: "kab.enrollment-challenge.v1",
        nonce: "enrollment-nonce-1",
        expiresAt: "2026-10-13T16:05:00.000Z",
      };
    },
    async register(_enrollmentToken, proof: SignedRegistrationProof) {
      registrationProofVerified = verifyRegistrationProof(proof).valid;

      return {
        version: "kab.installation-binding.v1",
        tenantId: "tenant-1",
        installationId: "installation-1",
        bridgeInstanceId: proof.payload.bridgeInstanceId,
        keyId: proof.payload.keyId,
        registeredAt: NOW.toISOString(),
        trustedApprovalKeys: [
          {
            keyId: APPROVAL_KEY_ID,
            publicKeyPem: approvalPair.publicKey
              .export({ format: "pem", type: "spki" })
              .toString(),
          },
        ],
      } satisfies InstallationBinding;
    },
  };

  const enrollmentClient = new InstallationEnrollmentClient(
    identityManager,
    enrollmentTransport,
    {
      runtimeVersion: "0.1.0",
      deploymentMode: "local",
      capabilities: ["orders.update"],
      bindingStore,
      now: () => NOW,
    },
  );
  const binding = await enrollmentClient.enroll("one-time-enrollment-token");

  assert.equal(registrationProofVerified, true);
  assert.deepEqual(await bindingStore.load(), binding);

  const identity = await identityManager.getOrCreate();
  let sessionProofVerified = false;
  const sessionTransport: OutboundSessionTransport = {
    async requestSessionChallenge() {
      return {
        version: "kab.session-challenge.v1",
        nonce: "session-nonce-1",
        expiresAt: "2026-10-13T16:05:00.000Z",
      };
    },
    async openSession(proof: SignedSessionProof) {
      sessionProofVerified = verifySessionProof(proof, identity.publicKeyPem);
      return {
        version: "kab.session-credential.v1",
        sessionId: "session-1",
        tenantId: binding.tenantId,
        installationId: binding.installationId,
        bridgeInstanceId: binding.bridgeInstanceId,
        keyId: binding.keyId,
        accessToken: "session-secret-that-must-not-enter-audit",
        issuedAt: NOW.toISOString(),
        expiresAt: "2026-10-13T16:30:00.000Z",
        heartbeatIntervalSeconds: 15,
      } satisfies SessionCredential;
    },
    async sendHeartbeat() {
      return {
        version: "kab.heartbeat-ack.v1",
        receivedAt: NOW.toISOString(),
      };
    },
  };

  const session = await new ControlSessionClient(
    identityManager,
    sessionTransport,
    {
      runtimeVersion: "0.1.0",
      capabilities: ["orders.update"],
      now: () => NOW,
    },
  ).open(binding);

  assert.equal(sessionProofVerified, true);
  assert.equal((await session.heartbeat("ready")).version, "kab.heartbeat-ack.v1");

  const approvalKeyManager = new ApprovalKeySetManager(
    binding,
    new InMemoryApprovalKeySetStore(),
    { now: () => NOW },
  );
  const verifier = new SignedApprovalVerifier({
    now: () => NOW,
    resolvePublicKey: (keyId) => approvalKeyManager.resolvePublicKey(keyId),
  });
  const policy = new SignedApprovalPolicyEvaluator(verifier, {
    replayStore: new InMemoryApprovalReplayStore(),
    now: () => NOW,
  });

  const registry = new ToolRegistry();
  let writeExecutions = 0;
  registry.register({
    id: "orders.update",
    name: "Update order",
    description: "Acceptance WRITE tool",
    risk: "WRITE",
    async execute(input) {
      writeExecutions += 1;
      return { ok: true, input };
    },
  });

  const auditOutbox = new InMemoryAuditOutboxStore();
  const auditSink = new SanitizedAuditSink(
    {
      tenantId: binding.tenantId,
      installationId: binding.installationId,
      bridgeInstanceId: binding.bridgeInstanceId,
    },
    auditOutbox,
  );
  const runtime = new BridgeRuntime({ registry, policy, audit: auditSink });
  const processor = new CommandProcessor(
    runtime,
    new InMemoryCommandReceiptStore(),
    { now: () => NOW },
  );

  const input = { orderId: 42, status: "processing" };
  const correlationId = "corr-phase1-1";
  const actionFingerprint = createActionFingerprint({
    tenantId: binding.tenantId,
    installationId: binding.installationId,
    toolId: "orders.update",
    correlationId,
    input,
  });
  const approvalPayload: ApprovalPayload = {
    version: "kab.approval.v1",
    decision: "ALLOW",
    tenantId: binding.tenantId,
    installationId: binding.installationId,
    toolId: "orders.update",
    correlationId,
    actionFingerprint,
    issuedAt: "2026-10-13T15:59:00.000Z",
    expiresAt: "2026-10-13T16:05:00.000Z",
    nonce: "approval-nonce-phase1-1",
  };
  const approvalToken = createApprovalToken(approvalPayload);

  const baseCommand = {
    version: "kab.command.v1" as const,
    deliveryAttempt: 1,
    tenantId: binding.tenantId,
    installationId: binding.installationId,
    bridgeInstanceId: binding.bridgeInstanceId,
    correlationId,
    actor: "agent-1",
    toolId: "orders.update",
    input,
    actionFingerprint,
    approvalToken,
    issuedAt: "2026-10-13T15:59:30.000Z",
    expiresAt: "2026-10-13T16:10:00.000Z",
  };

  const first = await processor.process(
    { ...baseCommand, commandId: "command-1" },
    session.credential,
  );
  const replayWithDifferentCommandId = await processor.process(
    { ...baseCommand, commandId: "command-2" },
    session.credential,
  );

  assert.equal(first.status, "executed");
  assert.equal(replayWithDifferentCommandId.status, "denied");
  assert.equal(writeExecutions, 1);

  const queuedAudit = await auditOutbox.peek(100);
  assert.ok(queuedAudit.length >= 6);
  assert.ok(
    queuedAudit.every(
      (event) =>
        event.tenantId === binding.tenantId &&
        event.installationId === binding.installationId &&
        event.bridgeInstanceId === binding.bridgeInstanceId,
    ),
  );
  assert.doesNotMatch(JSON.stringify(queuedAudit), /session-secret-that-must-not-enter-audit/);
  assert.doesNotMatch(JSON.stringify(queuedAudit), /kab1\./);

  let deliveredBatch: AuditBatch | null = null;
  const auditTransport: AuditDeliveryTransport = {
    async sendAuditBatch(accessToken, batch) {
      assert.equal(accessToken, session.credential.accessToken);
      deliveredBatch = batch;
      return {
        version: "kab.audit-batch-ack.v1",
        batchId: batch.batchId,
        acceptedEventIds: batch.events.map((event) => event.eventId),
      };
    },
  };

  const flush = await new AuditDeliveryClient(
    session,
    auditOutbox,
    auditTransport,
  ).flushOnce();

  assert.notEqual(deliveredBatch, null);
  assert.equal(flush.sent, queuedAudit.length);
  assert.equal(flush.acknowledged, queuedAudit.length);
  assert.equal(flush.remaining, 0);
});

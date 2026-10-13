import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BridgeRuntime,
  CommandProcessor,
  FileApprovalReplayStore,
  InMemoryApprovalReplayStore,
  InMemoryCommandReceiptStore,
  SignedApprovalPolicyEvaluator,
  SignedApprovalVerifier,
  ToolRegistry,
  canonicalJson,
  createActionFingerprint,
  type ApprovalPayload,
  type CommandEnvelope,
  type SessionCredential,
} from "../../src/index.js";

const NOW = new Date("2026-10-13T14:30:00.000Z");
const KEY_ID = "platform-key-replay";
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const publicKeyPem = publicKey
  .export({ format: "pem", type: "spki" })
  .toString();

function createApprovalToken(payload: ApprovalPayload): string {
  const keyIdSegment = Buffer.from(KEY_ID, "utf8").toString("base64url");
  const payloadSegment = Buffer.from(canonicalJson(payload), "utf8").toString(
    "base64url",
  );
  const signingInput = `kab1.${keyIdSegment}.${payloadSegment}`;
  const signature = sign(null, Buffer.from(signingInput, "utf8"), privateKey);
  return `${signingInput}.${signature.toString("base64url")}`;
}

function createPayload(input: unknown, nonce = "nonce-replay-1"): ApprovalPayload {
  const request = {
    tenantId: "tenant-1",
    installationId: "installation-1",
    toolId: "orders.update",
    correlationId: "corr-replay-1",
    input,
  };

  return {
    version: "kab.approval.v1",
    decision: "ALLOW",
    tenantId: request.tenantId,
    installationId: request.installationId,
    toolId: request.toolId,
    correlationId: request.correlationId,
    actionFingerprint: createActionFingerprint(request),
    issuedAt: "2026-10-13T14:29:00.000Z",
    expiresAt: "2026-10-13T14:35:00.000Z",
    nonce,
  };
}

function createVerifier(): SignedApprovalVerifier {
  return new SignedApprovalVerifier({
    now: () => NOW,
    resolvePublicKey: async (keyId) =>
      keyId === KEY_ID ? publicKeyPem : null,
  });
}

test("filesystem replay store survives restart and blocks the same nonce", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kab-approval-replay-"));
  const filePath = join(directory, "approval-replay.json");

  const record = {
    version: "kab.approval-replay.v1" as const,
    nonce: "nonce-persisted",
    tenantId: "tenant-1",
    installationId: "installation-1",
    toolId: "orders.update",
    correlationId: "corr-1",
    actionFingerprint: "fingerprint-1",
    consumedAt: NOW.toISOString(),
    retainUntil: "2026-10-14T14:30:00.000Z",
  };

  try {
    const firstStore = new FileApprovalReplayStore(filePath);
    assert.equal(await firstStore.consume(record), true);

    const restartedStore = new FileApprovalReplayStore(filePath);
    assert.equal(await restartedStore.consume(record), false);
    assert.deepEqual(await restartedStore.get(record.nonce), record);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrent consume calls allow exactly one use of a nonce", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kab-approval-race-"));
  const filePath = join(directory, "approval-replay.json");
  const store = new FileApprovalReplayStore(filePath);
  const record = {
    version: "kab.approval-replay.v1" as const,
    nonce: "nonce-race",
    tenantId: "tenant-1",
    installationId: "installation-1",
    toolId: "orders.update",
    correlationId: "corr-race",
    actionFingerprint: "fingerprint-race",
    consumedAt: NOW.toISOString(),
    retainUntil: "2026-10-14T14:30:00.000Z",
  };

  try {
    const results = await Promise.all([
      store.consume(record),
      store.consume(record),
      store.consume(record),
    ]);

    assert.equal(results.filter(Boolean).length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("expired replay records can be pruned", async () => {
  const store = new InMemoryApprovalReplayStore();

  await store.consume({
    version: "kab.approval-replay.v1",
    nonce: "old-nonce",
    tenantId: "tenant-1",
    installationId: "installation-1",
    toolId: "orders.update",
    correlationId: "corr-old",
    actionFingerprint: "old-fingerprint",
    consumedAt: "2026-10-12T10:00:00.000Z",
    retainUntil: "2026-10-13T10:00:00.000Z",
  });

  assert.equal(await store.prune(NOW), 1);
  assert.equal(await store.get("old-nonce"), null);
});

test("same signed approval cannot authorize a different command ID", async () => {
  const replayStore = new InMemoryApprovalReplayStore();
  const policy = new SignedApprovalPolicyEvaluator(createVerifier(), {
    replayStore,
    now: () => NOW,
  });
  const registry = new ToolRegistry();
  let executions = 0;

  registry.register({
    id: "orders.update",
    name: "Update order",
    description: "Update order for approval replay test",
    risk: "WRITE",
    async execute(input) {
      executions += 1;
      return input;
    },
  });

  const runtime = new BridgeRuntime({ registry, policy });
  const processor = new CommandProcessor(
    runtime,
    new InMemoryCommandReceiptStore(),
    { now: () => NOW },
  );
  const input = { orderId: 42, status: "processing" };
  const payload = createPayload(input);
  const approvalToken = createApprovalToken(payload);
  const credential: SessionCredential = {
    version: "kab.session-credential.v1",
    sessionId: "session-1",
    tenantId: payload.tenantId,
    installationId: payload.installationId,
    bridgeInstanceId: "bridge-1",
    keyId: "bridge-key-1",
    accessToken: "session-secret",
    issuedAt: "2026-10-13T14:29:00.000Z",
    expiresAt: "2026-10-13T15:00:00.000Z",
    heartbeatIntervalSeconds: 15,
  };

  function command(commandId: string): CommandEnvelope {
    return {
      version: "kab.command.v1",
      commandId,
      deliveryAttempt: 1,
      tenantId: payload.tenantId,
      installationId: payload.installationId,
      bridgeInstanceId: credential.bridgeInstanceId,
      correlationId: payload.correlationId,
      actor: "agent-1",
      toolId: payload.toolId,
      input,
      actionFingerprint: payload.actionFingerprint,
      approvalToken,
      issuedAt: "2026-10-13T14:29:30.000Z",
      expiresAt: "2026-10-13T14:40:00.000Z",
    };
  }

  const first = await processor.process(command("command-a"), credential);
  const second = await processor.process(command("command-b"), credential);

  assert.equal(first.status, "executed");
  assert.equal(second.status, "denied");
  assert.match(second.reason ?? "", /already been consumed/);
  assert.equal(executions, 1);
});

test("replay store failure denies a verified ALLOW approval", async () => {
  const replayStore = {
    async consume() {
      throw new Error("disk unavailable");
    },
    async get() {
      return null;
    },
    async prune() {
      return 0;
    },
  };
  const policy = new SignedApprovalPolicyEvaluator(createVerifier(), {
    replayStore,
    now: () => NOW,
  });
  const input = { orderId: 42, status: "processing" };
  const payload = createPayload(input, "nonce-store-failure");

  const decision = await policy.evaluate(
    {
      id: payload.toolId,
      name: "Update order",
      description: "Replay fail-closed test",
      risk: "WRITE",
      async execute() {
        return null;
      },
    },
    input,
    {
      correlationId: payload.correlationId,
      actor: "agent-1",
      tenantId: payload.tenantId,
      installationId: payload.installationId,
      approvalToken: createApprovalToken(payload),
    },
  );

  assert.deepEqual(decision, {
    outcome: "DENY",
    reason: "Approval replay protection is unavailable.",
  });
});

import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  sign as signPayload,
  type KeyObject,
} from "node:crypto";
import test from "node:test";

import {
  DelegationPolicyEvaluator,
  SecureDefaultPolicyEvaluator,
  SignedAgentDelegationVerifier,
  type AgentDelegationPayload,
  type InvocationContext,
  type ToolDefinition,
} from "../../src/index.js";

const NOW = new Date("2026-10-14T07:00:00.000Z");

function payload(
  overrides: Partial<AgentDelegationPayload> = {},
): AgentDelegationPayload {
  return {
    version: "kab.agent-delegation.v1",
    audience: "kairoseth-agent-bridge",
    delegationId: "delegation-1",
    tenantId: "tenant-1",
    installationId: "installation-1",
    delegatorActor: "agent:owner",
    delegateActor: "agent:delegate",
    toolIds: ["demo.read", "demo.write"],
    maxRisk: "WRITE",
    issuedAt: "2026-10-14T06:55:00.000Z",
    expiresAt: "2026-10-14T08:00:00.000Z",
    ...overrides,
  };
}

function tokenFor(
  privateKey: KeyObject,
  value: AgentDelegationPayload,
  keyId = "platform-key-1",
): string {
  const keySegment = Buffer.from(keyId, "utf8").toString("base64url");
  const payloadSegment = Buffer.from(
    JSON.stringify(value),
    "utf8",
  ).toString("base64url");
  const signingInput = `kabd1.${keySegment}.${payloadSegment}`;
  const signature = signPayload(
    null,
    Buffer.from(signingInput, "utf8"),
    privateKey,
  ).toString("base64url");
  return `${signingInput}.${signature}`;
}

function context(delegationToken?: string): InvocationContext {
  return {
    correlationId: "correlation-1",
    actor: "agent:delegate",
    tenantId: "tenant-1",
    installationId: "installation-1",
    delegationRequired: true,
    ...(delegationToken ? { delegationToken } : {}),
  };
}

function tool(
  id: string,
  risk: "READ" | "WRITE" | "CRITICAL",
): ToolDefinition {
  return {
    id,
    name: id,
    description: id,
    risk,
    async execute() {
      return { ok: true };
    },
  };
}

test("signed delegation verifies exact identity/tool scope and risk ceiling", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const verifier = new SignedAgentDelegationVerifier({
    resolvePublicKey: async () =>
      publicKey.export({ type: "spki", format: "pem" }).toString(),
    now: () => NOW,
  });
  const token = tokenFor(privateKey, payload());

  const read = await verifier.verify(token, {
    tenantId: "tenant-1",
    installationId: "installation-1",
    delegateActor: "agent:delegate",
    toolId: "demo.read",
    risk: "READ",
  });
  assert.equal(read.valid, true);

  const write = await verifier.verify(token, {
    tenantId: "tenant-1",
    installationId: "installation-1",
    delegateActor: "agent:delegate",
    toolId: "demo.write",
    risk: "WRITE",
  });
  assert.equal(write.valid, true);

  const critical = await verifier.verify(token, {
    tenantId: "tenant-1",
    installationId: "installation-1",
    delegateActor: "agent:delegate",
    toolId: "demo.write",
    risk: "CRITICAL",
  });
  assert.deepEqual(critical, {
    valid: false,
    reason: "Delegation does not allow the requested risk level.",
  });

  const wrongActor = await verifier.verify(token, {
    tenantId: "tenant-1",
    installationId: "installation-1",
    delegateActor: "agent:other",
    toolId: "demo.read",
    risk: "READ",
  });
  assert.equal(wrongActor.valid, false);

  const wrongTool = await verifier.verify(token, {
    tenantId: "tenant-1",
    installationId: "installation-1",
    delegateActor: "agent:delegate",
    toolId: "demo.other",
    risk: "READ",
  });
  assert.deepEqual(wrongTool, {
    valid: false,
    reason: "Delegation does not allow the requested tool.",
  });
});

test("delegation verifier rejects expiry, excessive lifetime and revocation fail-closed", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();

  const expiredVerifier = new SignedAgentDelegationVerifier({
    resolvePublicKey: async () => publicPem,
    now: () => new Date("2026-10-15T09:00:00.000Z"),
  });
  const expired = await expiredVerifier.verify(tokenFor(privateKey, payload()), {
    tenantId: "tenant-1",
    installationId: "installation-1",
    delegateActor: "agent:delegate",
    toolId: "demo.read",
    risk: "READ",
  });
  assert.equal(expired.valid, false);
  assert.match(expired.reason, /expired/i);

  const lifetimeVerifier = new SignedAgentDelegationVerifier({
    resolvePublicKey: async () => publicPem,
    now: () => NOW,
    maxGrantLifetimeMs: 60 * 60 * 1_000,
  });
  const tooLong = await lifetimeVerifier.verify(tokenFor(privateKey, payload()), {
    tenantId: "tenant-1",
    installationId: "installation-1",
    delegateActor: "agent:delegate",
    toolId: "demo.read",
    risk: "READ",
  });
  assert.equal(tooLong.valid, false);
  assert.match(tooLong.reason, /lifetime/i);

  const revokedVerifier = new SignedAgentDelegationVerifier({
    resolvePublicKey: async () => publicPem,
    isRevoked: async () => true,
    now: () => NOW,
  });
  const revoked = await revokedVerifier.verify(tokenFor(privateKey, payload()), {
    tenantId: "tenant-1",
    installationId: "installation-1",
    delegateActor: "agent:delegate",
    toolId: "demo.read",
    risk: "READ",
  });
  assert.deepEqual(revoked, {
    valid: false,
    reason: "Delegation has been revoked.",
  });

  const unavailableVerifier = new SignedAgentDelegationVerifier({
    resolvePublicKey: async () => publicPem,
    isRevoked: async () => {
      throw new Error("backend unavailable");
    },
    now: () => NOW,
  });
  const unavailable = await unavailableVerifier.verify(
    tokenFor(privateKey, payload()),
    {
      tenantId: "tenant-1",
      installationId: "installation-1",
      delegateActor: "agent:delegate",
      toolId: "demo.read",
      risk: "READ",
    },
  );
  assert.deepEqual(unavailable, {
    valid: false,
    reason: "Delegation revocation status is unavailable.",
  });
});

test("delegation policy limits access but never replaces WRITE approval", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const verifier = new SignedAgentDelegationVerifier({
    resolvePublicKey: async () =>
      publicKey.export({ type: "spki", format: "pem" }).toString(),
    now: () => NOW,
  });
  const policy = new DelegationPolicyEvaluator(
    new SecureDefaultPolicyEvaluator(),
    verifier,
  );
  const token = tokenFor(privateKey, payload());

  const noGrant = await policy.evaluate(tool("demo.read", "READ"), {}, context());
  assert.equal(noGrant.outcome, "DENY");

  const read = await policy.evaluate(
    tool("demo.read", "READ"),
    {},
    context(token),
  );
  assert.equal(read.outcome, "ALLOW");

  const write = await policy.evaluate(
    tool("demo.write", "WRITE"),
    {},
    context(token),
  );
  assert.equal(write.outcome, "REQUIRE_APPROVAL");

  const wrongTool = await policy.evaluate(
    tool("demo.other", "READ"),
    {},
    context(token),
  );
  assert.equal(wrongTool.outcome, "DENY");
});

test("non-delegated principals continue to use the wrapped base policy", async () => {
  const { publicKey } = generateKeyPairSync("ed25519");
  const policy = new DelegationPolicyEvaluator(
    new SecureDefaultPolicyEvaluator(),
    new SignedAgentDelegationVerifier({
      resolvePublicKey: async () =>
        publicKey.export({ type: "spki", format: "pem" }).toString(),
      now: () => NOW,
    }),
  );

  const decision = await policy.evaluate(tool("demo.read", "READ"), {}, {
    correlationId: "direct-1",
    actor: "user:direct",
    tenantId: "tenant-1",
    installationId: "installation-1",
  });
  assert.equal(decision.outcome, "ALLOW");
});

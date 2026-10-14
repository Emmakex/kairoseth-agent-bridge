import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  sign as signPayload,
  type KeyObject,
} from "node:crypto";
import test from "node:test";

import {
  A2AIdentityMapper,
  A2AToolExecutionAdapter,
  BridgeRuntime,
  DelegationPolicyEvaluator,
  KAIROSETH_A2A_TOOL_INVOCATION_EXTENSION_URI,
  SecureDefaultPolicyEvaluator,
  SignedAgentDelegationVerifier,
  ToolRegistry,
  type A2ASendMessageRequest,
  type AgentDelegationPayload,
  type ToolDefinition,
} from "../../src/index.js";

const NOW = new Date("2026-10-14T07:10:00.000Z");

function signDelegation(
  privateKey: KeyObject,
  payload: AgentDelegationPayload,
): string {
  const keySegment = Buffer.from("platform-key-1", "utf8").toString("base64url");
  const payloadSegment = Buffer.from(
    JSON.stringify(payload),
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

function request(toolId: string, input: unknown): A2ASendMessageRequest {
  return {
    message: {
      messageId: `message-${toolId}`,
      role: "ROLE_USER",
      extensions: [KAIROSETH_A2A_TOOL_INVOCATION_EXTENSION_URI],
      parts: [
        {
          mediaType: "application/json",
          data: {
            version: "kairoseth.tool-invocation.v1",
            toolId,
            input,
          },
        },
      ],
    },
  };
}

function tool(
  id: string,
  risk: "READ" | "WRITE",
  execute: ToolDefinition["execute"],
): ToolDefinition {
  return {
    id,
    name: id,
    description: id,
    localizations: {
      es: { name: `ES ${id}`, description: `Descripción ES ${id}` },
      en: { name: `EN ${id}`, description: `EN description ${id}` },
    },
    risk,
    execute,
  };
}

test("verified A2A principal -> Kairoseth binding -> signed delegation -> BridgeRuntime", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const delegationPayload: AgentDelegationPayload = {
    version: "kab.agent-delegation.v1",
    audience: "kairoseth-agent-bridge",
    delegationId: "delegation-acceptance-1",
    tenantId: "tenant-platform",
    installationId: "installation-platform",
    delegatorActor: "agent:owner",
    delegateActor: "agent:external:42",
    toolIds: ["demo.orders.read", "demo.orders.update"],
    maxRisk: "WRITE",
    issuedAt: "2026-10-14T07:00:00.000Z",
    expiresAt: "2026-10-14T08:00:00.000Z",
  };
  const delegationToken = signDelegation(privateKey, delegationPayload);

  const mapper = new A2AIdentityMapper(async (principal) => {
    assert.equal(principal.issuer, "https://id.example.com");
    assert.equal(principal.subject, "external-agent-42");
    return {
      actor: "agent:external:42",
      tenantId: "tenant-platform",
      installationId: "installation-platform",
      delegationRequired: true,
    };
  });

  const mapped = await mapper.map({
    principal: {
      issuer: "https://id.example.com",
      subject: "external-agent-42",
      authenticationMethod: "oauth2",
      clientId: "external-client",
      scopes: ["bridge.invoke"],
    },
    correlationId: "correlation-delegated-1",
    activatedExtensions: [KAIROSETH_A2A_TOOL_INVOCATION_EXTENSION_URI],
    locale: "en",
    delegationToken,
  });
  assert.equal(mapped.mapped, true);
  if (!mapped.mapped) return;

  let reads = 0;
  let writes = 0;
  const registry = new ToolRegistry();
  registry.register(
    tool("demo.orders.read", "READ", async (_input, invocation) => {
      reads += 1;
      assert.equal(invocation.actor, "agent:external:42");
      assert.equal(invocation.tenantId, "tenant-platform");
      assert.equal(invocation.installationId, "installation-platform");
      assert.equal(invocation.delegationRequired, true);
      assert.equal(invocation.delegationToken, delegationToken);
      return { id: 42, status: "processing" };
    }),
  );
  registry.register(
    tool("demo.orders.update", "WRITE", async () => {
      writes += 1;
      return { ok: true };
    }),
  );

  const delegationVerifier = new SignedAgentDelegationVerifier({
    resolvePublicKey: async () =>
      publicKey.export({ type: "spki", format: "pem" }).toString(),
    now: () => NOW,
  });
  const policy = new DelegationPolicyEvaluator(
    new SecureDefaultPolicyEvaluator(),
    delegationVerifier,
  );
  const adapter = new A2AToolExecutionAdapter(
    new BridgeRuntime({ registry, policy }),
    {
      idGenerator: (() => {
        let id = 0;
        return () => `acceptance-${++id}`;
      })(),
      now: () => NOW,
    },
  );

  const readResponse = await adapter.sendMessage(
    request("demo.orders.read", { id: 42 }),
    mapped.context,
  );
  assert.equal(readResponse.task?.status.state, "TASK_STATE_COMPLETED");
  assert.equal(reads, 1);

  const writeResponse = await adapter.sendMessage(
    request("demo.orders.update", { id: 42, status: "completed" }),
    {
      ...mapped.context,
      invocation: {
        ...mapped.context.invocation,
        correlationId: "correlation-delegated-write",
      },
    },
  );
  assert.equal(writeResponse.task?.status.state, "TASK_STATE_AUTH_REQUIRED");
  assert.equal(writes, 0);
});

test("delegated A2A principal cannot use a tool outside its signed allowlist", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const delegationToken = signDelegation(privateKey, {
    version: "kab.agent-delegation.v1",
    audience: "kairoseth-agent-bridge",
    delegationId: "delegation-acceptance-2",
    tenantId: "tenant-platform",
    installationId: "installation-platform",
    delegatorActor: "agent:owner",
    delegateActor: "agent:external:42",
    toolIds: ["demo.allowed"],
    maxRisk: "READ",
    issuedAt: "2026-10-14T07:00:00.000Z",
    expiresAt: "2026-10-14T08:00:00.000Z",
  });

  const mapper = new A2AIdentityMapper(async () => ({
    actor: "agent:external:42",
    tenantId: "tenant-platform",
    installationId: "installation-platform",
    delegationRequired: true,
  }));
  const mapped = await mapper.map({
    principal: {
      issuer: "https://id.example.com",
      subject: "external-agent-42",
      authenticationMethod: "oauth2",
    },
    correlationId: "correlation-denied-tool",
    activatedExtensions: [KAIROSETH_A2A_TOOL_INVOCATION_EXTENSION_URI],
    delegationToken,
  });
  assert.equal(mapped.mapped, true);
  if (!mapped.mapped) return;

  let executions = 0;
  const registry = new ToolRegistry();
  registry.register(
    tool("demo.forbidden", "READ", async () => {
      executions += 1;
      return { ok: true };
    }),
  );
  const policy = new DelegationPolicyEvaluator(
    new SecureDefaultPolicyEvaluator(),
    new SignedAgentDelegationVerifier({
      resolvePublicKey: async () =>
        publicKey.export({ type: "spki", format: "pem" }).toString(),
      now: () => NOW,
    }),
  );
  const adapter = new A2AToolExecutionAdapter(
    new BridgeRuntime({ registry, policy }),
  );

  const response = await adapter.sendMessage(
    request("demo.forbidden", {}),
    mapped.context,
  );
  assert.equal(response.task?.status.state, "TASK_STATE_REJECTED");
  assert.equal(executions, 0);
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  A2AIdentityMapper,
  KAIROSETH_A2A_TOOL_INVOCATION_EXTENSION_URI,
  type A2APrincipalBinding,
  type A2AVerifiedTransportPrincipal,
} from "../../src/index.js";

const principal: A2AVerifiedTransportPrincipal = {
  issuer: "https://id.example.com",
  subject: "external-agent-42",
  authenticationMethod: "oauth2",
  clientId: "client-42",
  scopes: ["orders.read", "bridge.invoke"],
};

const binding: A2APrincipalBinding = {
  actor: "agent:external:42",
  tenantId: "tenant-authoritative",
  installationId: "installation-authoritative",
  delegationRequired: true,
};

test("A2A identity mapper assigns tenant/installation only from authoritative resolver", async () => {
  let resolverPrincipal: A2AVerifiedTransportPrincipal | undefined;
  const mapper = new A2AIdentityMapper(async (value) => {
    resolverPrincipal = value;
    return binding;
  });

  const result = await mapper.map({
    principal: {
      ...principal,
      scopes: ["orders.read", "bridge.invoke"],
    },
    correlationId: "correlation-identity-1",
    activatedExtensions: [KAIROSETH_A2A_TOOL_INVOCATION_EXTENSION_URI],
    locale: "es",
    approvalToken: "approval-token-from-trusted-host",
    delegationToken: "delegation-token-from-trusted-host",
  });

  assert.equal(result.mapped, true);
  if (!result.mapped) return;

  assert.equal(result.context.invocation.actor, "agent:external:42");
  assert.equal(result.context.invocation.tenantId, "tenant-authoritative");
  assert.equal(
    result.context.invocation.installationId,
    "installation-authoritative",
  );
  assert.equal(result.context.invocation.delegationRequired, true);
  assert.equal(
    result.context.invocation.approvalToken,
    "approval-token-from-trusted-host",
  );
  assert.equal(
    result.context.invocation.delegationToken,
    "delegation-token-from-trusted-host",
  );
  assert.equal(result.context.locale, "es");
  assert.deepEqual(result.context.activatedExtensions, [
    KAIROSETH_A2A_TOOL_INVOCATION_EXTENSION_URI,
  ]);
  assert.equal(
    result.context.invocation.metadata?.["a2a.auth.subject"],
    "external-agent-42",
  );
  assert.equal(
    result.context.invocation.metadata?.["a2a.auth.issuer"],
    "https://id.example.com",
  );
  assert.equal(
    result.context.invocation.metadata?.["a2a.auth.method"],
    "oauth2",
  );
  assert.equal(
    result.context.invocation.metadata?.["a2a.auth.clientId"],
    "client-42",
  );
  assert.equal(
    result.context.invocation.metadata?.["a2a.auth.scopes"],
    "bridge.invoke orders.read",
  );
  assert.equal(
    "approvalToken" in (result.context.invocation.metadata ?? {}),
    false,
  );
  assert.equal(
    "delegationToken" in (result.context.invocation.metadata ?? {}),
    false,
  );
  assert.deepEqual(resolverPrincipal?.scopes, ["bridge.invoke", "orders.read"]);
});

test("A2A identity mapper fails closed when binding is missing or resolver fails", async () => {
  const missing = new A2AIdentityMapper(async () => null);
  const missingResult = await missing.map({
    principal,
    correlationId: "correlation-missing",
    activatedExtensions: [],
  });
  assert.deepEqual(missingResult, {
    mapped: false,
    reason: "A2A principal is not bound to an authorized Kairoseth installation.",
  });

  const failing = new A2AIdentityMapper(async () => {
    throw new Error("backend unavailable");
  });
  const failingResult = await failing.map({
    principal,
    correlationId: "correlation-failing",
    activatedExtensions: [],
  });
  assert.deepEqual(failingResult, {
    mapped: false,
    reason: "Kairoseth A2A principal binding lookup failed.",
  });
});

test("A2A identity mapper rejects malformed verified-principal evidence", async () => {
  const mapper = new A2AIdentityMapper(async () => binding);

  const duplicateScopes = await mapper.map({
    principal: {
      ...principal,
      scopes: ["same", "same"],
    },
    correlationId: "correlation-duplicate",
    activatedExtensions: [],
  });
  assert.equal(duplicateScopes.mapped, false);

  const badExtension = await mapper.map({
    principal,
    correlationId: "correlation-extension",
    activatedExtensions: ["http://insecure.example.com/extension"],
  });
  assert.equal(badExtension.mapped, false);

  const badToken = await mapper.map({
    principal,
    correlationId: "correlation-token",
    activatedExtensions: [],
    delegationToken: "bad\nvalue",
  });
  assert.equal(badToken.mapped, false);
});

test("A2A identity mapper rejects invalid authoritative bindings instead of trusting them", async () => {
  const mapper = new A2AIdentityMapper(async () => ({
    actor: "agent:external:42",
    tenantId: "",
    installationId: "installation-authoritative",
    delegationRequired: true,
  }));

  const result = await mapper.map({
    principal,
    correlationId: "correlation-invalid-binding",
    activatedExtensions: [],
  });
  assert.deepEqual(result, {
    mapped: false,
    reason: "A2A principal is not bound to an authorized Kairoseth installation.",
  });
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  ConnectorCredentialRotationError,
  ConnectorCredentialRotationPendingError,
  ConnectorRegistryAdapter,
  ToolRegistry,
  type ConnectorCredentialRotationNotice,
  type ConnectorDefinition,
  type ConnectorInstance,
  type ConnectorSecretProvider,
} from "../../src/index.js";

function rotationNotice(
  rotationId = "rot-2026-10-14-001",
): ConnectorCredentialRotationNotice {
  return {
    rotationId,
    requirementId: "api",
    fieldIds: ["token"],
    rotatedAt: "2026-10-14T10:00:00.000Z",
    revision: "vault-rev-2",
  };
}

function connector(
  overrides: Partial<ConnectorDefinition> = {},
): ConnectorDefinition {
  return {
    manifest: {
      id: "rotation-fixture",
      name: "Rotation Fixture",
      version: "1.0.0",
      description: "Credential rotation test fixture",
      capabilities: ["credential.read"],
      credentials: [
        {
          id: "api",
          kind: "bearer",
          label: "API credential",
          required: true,
          fields: [
            {
              id: "token",
              label: "Token",
              secret: true,
              required: true,
            },
          ],
        },
      ],
    },
    tools: [
      {
        id: "credential.read",
        name: "Read credential version",
        description: "Returns the test provider value",
        risk: "READ",
        inputSchema: { type: "object" },
        async execute(_input, context) {
          return await context.secrets.getSecret("api", "token");
        },
      },
    ],
    ...overrides,
  };
}

function instance(
  secrets: ConnectorSecretProvider,
  definition = connector(),
): ConnectorInstance {
  return {
    instanceId: "shop-bcn",
    connector: definition,
    secrets,
  };
}

const invocation = {
  correlationId: "corr-credential-rotation",
  actor: "agent-1",
};

test("credential rotation blocks execution until provider refresh completes and then uses the new secret", async () => {
  let value = "old-token";
  let releaseRefresh!: () => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });

  const secrets: ConnectorSecretProvider = {
    async getSecret() {
      return value;
    },
    async refreshCredentials(_notice, context) {
      markStarted();
      await gate;
      assert.equal(context.signal.aborted, false);
      value = "new-token";
    },
  };

  const registry = new ToolRegistry();
  const adapter = new ConnectorRegistryAdapter(registry, {
    defaultCredentialRotationTimeoutMs: 1_000,
  });
  const fixture = instance(secrets);
  adapter.register(fixture);
  const tool = registry.get("rotation-fixture.shop-bcn.credential.read")!;

  assert.equal(await tool.execute({}, invocation), "old-token");

  const rotating = adapter.credentialsRotated(fixture, rotationNotice());
  await started;

  assert.equal(adapter.credentialRotationState(fixture).status, "refreshing");
  await assert.rejects(
    () => tool.execute({}, invocation),
    (error: unknown) => error instanceof ConnectorCredentialRotationPendingError,
  );

  releaseRefresh();
  const result = await rotating;

  assert.equal(result.status, "applied");
  assert.equal(result.providerRefresh, "refreshed");
  assert.equal(result.connectorHook, "not_declared");
  assert.equal(adapter.credentialRotationState(fixture).status, "idle");
  assert.equal(await tool.execute({}, invocation), "new-token");
});

test("connector rotation hook runs after provider refresh and sees the current secret", async () => {
  let value = "old-token";
  const events: string[] = [];
  const secrets: ConnectorSecretProvider = {
    async getSecret() {
      return value;
    },
    async refreshCredentials() {
      events.push("provider");
      value = "new-token";
    },
  };
  const definition = connector({
    async credentialsRotated(_notice, context) {
      events.push(`connector:${await context.secrets.getSecret("api", "token")}`);
    },
  });
  const fixture = instance(secrets, definition);
  const adapter = new ConnectorRegistryAdapter(new ToolRegistry());
  adapter.register(fixture);

  const result = await adapter.credentialsRotated(fixture, rotationNotice());

  assert.deepEqual(events, ["provider", "connector:new-token"]);
  assert.equal(result.connectorHook, "applied");
});

test("failed rotation remains fail-closed, suppresses raw errors and surfaces health block state", async () => {
  let shouldFail = true;
  let value = "old-token";
  const secrets: ConnectorSecretProvider = {
    async getSecret() {
      return value;
    },
    async refreshCredentials() {
      if (shouldFail) {
        throw new Error("authorization=super-secret-should-not-leak");
      }
      value = "new-token";
    },
  };
  const registry = new ToolRegistry();
  const adapter = new ConnectorRegistryAdapter(registry);
  const fixture = instance(secrets);
  adapter.register(fixture);
  const notice = rotationNotice();

  await assert.rejects(
    () => adapter.credentialsRotated(fixture, notice),
    (error: unknown) => {
      assert.ok(error instanceof ConnectorCredentialRotationError);
      assert.equal(error.message.includes("super-secret-should-not-leak"), false);
      return true;
    },
  );

  assert.deepEqual(adapter.credentialRotationState(fixture), {
    status: "blocked",
    rotationId: notice.rotationId,
    requirementId: "api",
    fieldIds: ["token"],
    rotatedAt: notice.rotatedAt,
    revision: "vault-rev-2",
    failureReason: "apply_failed",
  });

  const tool = registry.get("rotation-fixture.shop-bcn.credential.read")!;
  await assert.rejects(
    () => tool.execute({}, invocation),
    (error: unknown) => error instanceof ConnectorCredentialRotationPendingError,
  );

  const health = await adapter.healthSnapshot(fixture);
  assert.equal(health.status, "unhealthy");
  assert.deepEqual(health.probe.details, { probe: "credential_rotation" });
  assert.equal(health.credentialRotation?.status, "blocked");
  assert.equal(health.tools[0]?.availability, "blocked");
  assert.equal(health.tools[0]?.blockedReason, "credential_rotation");

  shouldFail = false;
  const recovered = await adapter.credentialsRotated(fixture, notice);
  assert.equal(recovered.status, "applied");
  assert.equal(adapter.credentialRotationState(fixture).status, "idle");
  assert.equal(await tool.execute({}, invocation), "new-token");
});

test("credential rotation has a hard timeout even when a provider ignores AbortSignal", async () => {
  const secrets: ConnectorSecretProvider = {
    async getSecret() {
      return "old-token";
    },
    async refreshCredentials() {
      await new Promise(() => undefined);
    },
  };
  const registry = new ToolRegistry();
  const adapter = new ConnectorRegistryAdapter(registry, {
    defaultCredentialRotationTimeoutMs: 100,
  });
  const fixture = instance(secrets);
  adapter.register(fixture);

  const startedAt = Date.now();
  await assert.rejects(
    () => adapter.credentialsRotated(fixture, rotationNotice()),
    (error: unknown) => error instanceof ConnectorCredentialRotationError,
  );
  const elapsedMs = Date.now() - startedAt;

  assert.ok(elapsedMs < 1_000, `rotation took ${elapsedMs} ms`);
  assert.equal(
    adapter.credentialRotationState(fixture).failureReason,
    "timeout",
  );
});

test("undeclared credential fields are rejected before execution is blocked", async () => {
  const secrets: ConnectorSecretProvider = {
    async getSecret() {
      return "current-token";
    },
  };
  const registry = new ToolRegistry();
  const adapter = new ConnectorRegistryAdapter(registry);
  const fixture = instance(secrets);
  adapter.register(fixture);

  await assert.rejects(
    () =>
      adapter.credentialsRotated(fixture, {
        ...rotationNotice(),
        fieldIds: ["password"],
      }),
    /undeclared field/,
  );

  assert.equal(adapter.credentialRotationState(fixture).status, "idle");
  assert.equal(
    await registry
      .get("rotation-fixture.shop-bcn.credential.read")!
      .execute({}, invocation),
    "current-token",
  );
});

test("applied rotation IDs are idempotent within the running adapter", async () => {
  let refreshCalls = 0;
  let connectorHookCalls = 0;
  const secrets: ConnectorSecretProvider = {
    async getSecret() {
      return "current-token";
    },
    async refreshCredentials() {
      refreshCalls += 1;
    },
  };
  const definition = connector({
    async credentialsRotated() {
      connectorHookCalls += 1;
    },
  });
  const fixture = instance(secrets, definition);
  const adapter = new ConnectorRegistryAdapter(new ToolRegistry());
  adapter.register(fixture);
  const notice = rotationNotice("rot-idempotent-001");

  const first = await adapter.credentialsRotated(fixture, notice);
  const second = await adapter.credentialsRotated(fixture, notice);

  assert.deepEqual(second, first);
  assert.equal(refreshCalls, 1);
  assert.equal(connectorHookCalls, 1);
});

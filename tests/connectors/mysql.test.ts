import assert from "node:assert/strict";
import test from "node:test";

import {
  BridgeRuntime,
  ConnectorRegistryAdapter,
  McpToolAdapter,
  ToolRegistry,
  createMySqlConnector,
  type MySqlConnectionSettings,
  type MySqlExecutionRequest,
  type MySqlExecutionResult,
  type MySqlProfile,
  type MySqlRuntime,
  type PolicyEvaluator,
} from "../../src/index.js";

const readProfile: MySqlProfile = {
  id: "users.list",
  name: "List users",
  description: "List tenant users through a bounded prepared query.",
  localizations: {
    en: {
      name: "List MySQL users",
      description: "List tenant users through a bounded prepared query.",
    },
    es: {
      name: "Listar usuarios MySQL",
      description: "Lista usuarios del tenant mediante una consulta preparada y acotada.",
    },
  },
  risk: "READ",
  statement:
    "SELECT id, email, password FROM users WHERE tenant_id = ? AND status = COALESCE(?, status) LIMIT ?",
  parameters: [
    { id: "tenantId", type: "integer", minimum: 1 },
    { id: "status", type: "string", required: false, maxLength: 32 },
    { id: "limit", type: "integer", minimum: 1, maximum: 100 },
  ],
  maxRows: 100,
  redactColumns: ["email"],
};

const writeProfile: MySqlProfile = {
  id: "users.update-status",
  name: "Update user status",
  description: "Update one tenant user status through a prepared statement.",
  localizations: {
    en: {
      name: "Update MySQL user status",
      description: "Update one tenant user status through a declared prepared statement.",
    },
    es: {
      name: "Actualizar estado de usuario MySQL",
      description: "Actualiza el estado de un usuario del tenant mediante un prepared statement declarado.",
    },
  },
  risk: "WRITE",
  statement: "UPDATE users SET status = ? WHERE tenant_id = ? AND id = ?",
  parameters: [
    { id: "status", type: "string", maxLength: 32 },
    { id: "tenantId", type: "integer", minimum: 1 },
    { id: "userId", type: "integer", minimum: 1 },
  ],
  idempotency: { mode: "intrinsic" },
};

const criticalProfile: MySqlProfile = {
  id: "sessions.delete",
  name: "Delete session",
  description: "Delete one explicitly identified session.",
  localizations: {
    en: {
      name: "Delete MySQL session",
      description: "Delete one explicitly identified session through a declared profile.",
    },
    es: {
      name: "Eliminar sesión MySQL",
      description: "Elimina una sesión identificada explícitamente mediante un perfil declarado.",
    },
  },
  risk: "CRITICAL",
  statement: "DELETE FROM sessions WHERE tenant_id = ? AND id = ?",
  parameters: [
    { id: "tenantId", type: "integer", minimum: 1 },
    { id: "sessionId", type: "integer", minimum: 1 },
  ],
  idempotency: { mode: "intrinsic" },
};

const secrets = {
  async getSecret(requirementId: string, fieldId: string): Promise<string | null> {
    assert.equal(requirementId, "mysql_auth");
    if (fieldId === "username") return "bridge_user";
    if (fieldId === "password") return "super-secret-password";
    if (fieldId === "tls_ca") return "-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----";
    return null;
  },
};

const config = {
  host: "db.example.com",
  port: 3306,
  database: "appdb",
  tlsMode: "verify",
  connectTimeoutMs: 4000,
};

const allowPolicy: PolicyEvaluator = {
  async evaluate() {
    return { outcome: "ALLOW", reason: "approved by test policy" };
  },
};

function fakeRuntime(
  executeImpl: (
    settings: MySqlConnectionSettings,
    request: MySqlExecutionRequest,
  ) => Promise<MySqlExecutionResult>,
): MySqlRuntime {
  return {
    execute: executeImpl,
    async health() {},
  };
}

function register(
  runtime: MySqlRuntime,
  profiles: readonly MySqlProfile[] = [readProfile, writeProfile, criticalProfile],
) {
  const registry = new ToolRegistry();
  const connector = createMySqlConnector(
    { profiles, allowedHosts: ["db.example.com"] },
    runtime,
  );
  new ConnectorRegistryAdapter(registry, { sleep: async () => {} }).register({
    instanceId: "primary",
    connector,
    config,
    secrets,
  });
  return { registry, connector };
}

test("MySQL connector exposes declared profiles with ES/EN metadata and no SQL in manifest", () => {
  const runtime = fakeRuntime(async () => ({ kind: "rows", rows: [] }));
  const { registry, connector } = register(runtime);

  assert.equal(connector.manifest.id, "mysql");
  assert.deepEqual(connector.manifest.capabilities, [
    "profiles.critical",
    "profiles.read",
    "profiles.write",
  ]);
  assert.equal(connector.tools.length, 3);
  assert.doesNotMatch(JSON.stringify(connector.manifest), /SELECT|UPDATE|DELETE|super-secret-password/);
  assert.equal(connector.manifest.credentials[0]?.fields[1]?.secret, true);

  const mcp = new McpToolAdapter(new BridgeRuntime({ registry }));
  assert.equal(
    mcp.getTool("mysql.primary.users.list", "es")?.title,
    "Listar usuarios MySQL",
  );
  assert.equal(
    mcp.getTool("mysql.primary.users.list", "en")?.title,
    "List MySQL users",
  );
});

test("READ profile binds only declared prepared values and redacts result columns", async () => {
  let seenSettings: MySqlConnectionSettings | undefined;
  let seenRequest: MySqlExecutionRequest | undefined;
  const runtime = fakeRuntime(async (settings, request) => {
    seenSettings = settings;
    seenRequest = request;
    return {
      kind: "rows",
      rows: [
        {
          id: 7,
          email: "private@example.com",
          password: "hash-must-not-leak",
          display_name: "Ana",
        },
      ],
    };
  });
  const { registry } = register(runtime);

  const result = await new BridgeRuntime({ registry }).invoke(
    "mysql.primary.users.list",
    { tenantId: 9, limit: 25 },
    { correlationId: "corr-mysql-read", actor: "agent-mysql" },
  );

  assert.equal(result.status, "executed");
  assert.deepEqual(seenRequest?.values, [9, null, 25]);
  assert.equal(seenRequest?.mode, "read");
  assert.equal(seenSettings?.host, "db.example.com");
  assert.equal(seenSettings?.database, "appdb");
  assert.equal(seenSettings?.username, "bridge_user");
  assert.equal(seenSettings?.password, "super-secret-password");
  assert.equal(seenSettings?.tlsMode, "verify");
  assert.match(seenSettings?.tlsCa ?? "", /BEGIN CERTIFICATE/);

  if (result.status === "executed") {
    assert.deepEqual(result.output, {
      rows: [
        {
          id: 7,
          email: "[REDACTED]",
          password: "[REDACTED]",
          display_name: "Ana",
        },
      ],
      rowCount: 1,
    });
  }
});

test("agent input cannot add SQL, unknown parameters or invalid values", async () => {
  let calls = 0;
  const runtime = fakeRuntime(async () => {
    calls += 1;
    return { kind: "rows", rows: [] };
  });
  const { registry } = register(runtime);
  const bridge = new BridgeRuntime({ registry });

  const unknown = await bridge.invoke(
    "mysql.primary.users.list",
    { tenantId: 9, limit: 25, sql: "DROP TABLE users" },
    { correlationId: "corr-mysql-sql", actor: "agent-mysql" },
  );
  const invalid = await bridge.invoke(
    "mysql.primary.users.list",
    { tenantId: 9, limit: 1000 },
    { correlationId: "corr-mysql-limit", actor: "agent-mysql" },
  );

  assert.equal(unknown.status, "failed");
  assert.equal(invalid.status, "failed");
  assert.equal(calls, 0);
});

test("WRITE and CRITICAL profiles require approval before database execution", async () => {
  let calls = 0;
  const runtime = fakeRuntime(async () => {
    calls += 1;
    return { kind: "mutation", affectedRows: 1, changedRows: 1 };
  });
  const { registry } = register(runtime);
  const bridge = new BridgeRuntime({ registry });

  const write = await bridge.invoke(
    "mysql.primary.users.update-status",
    { status: "disabled", tenantId: 9, userId: 7 },
    { correlationId: "corr-mysql-write", actor: "agent-mysql" },
  );
  const critical = await bridge.invoke(
    "mysql.primary.sessions.delete",
    { tenantId: 9, sessionId: 11 },
    { correlationId: "corr-mysql-critical", actor: "agent-mysql" },
  );

  assert.equal(write.status, "approval_required");
  assert.equal(critical.status, "approval_required");
  assert.equal(calls, 0);
});

test("approved mutation returns only normalized mutation summary", async () => {
  let seenRequest: MySqlExecutionRequest | undefined;
  const runtime = fakeRuntime(async (_settings, request) => {
    seenRequest = request;
    return {
      kind: "mutation",
      affectedRows: 1,
      changedRows: 1,
      insertId: 0,
      warningStatus: 0,
    };
  });
  const { registry } = register(runtime);
  const bridge = new BridgeRuntime({ registry, policy: allowPolicy });

  const result = await bridge.invoke(
    "mysql.primary.users.update-status",
    { status: "disabled", tenantId: 9, userId: 7 },
    { correlationId: "corr-mysql-write-allow", actor: "approved-agent" },
  );

  assert.equal(result.status, "executed");
  assert.deepEqual(seenRequest?.values, ["disabled", 9, 7]);
  assert.equal(seenRequest?.mode, "mutation");
  if (result.status === "executed") {
    assert.deepEqual(result.output, {
      affectedRows: 1,
      changedRows: 1,
      insertId: 0,
      warningStatus: 0,
    });
  }
});

test("READ transient database errors retry, mutations never auto-retry", async () => {
  let readCalls = 0;
  const readRuntime = fakeRuntime(async () => {
    readCalls += 1;
    if (readCalls === 1) {
      const error = new Error("deadlock") as Error & { code: string };
      error.code = "ER_LOCK_DEADLOCK";
      throw error;
    }
    return { kind: "rows", rows: [{ id: 1 }] };
  });
  const { registry: readRegistry } = register(readRuntime, [readProfile]);
  const readResult = await new BridgeRuntime({ registry: readRegistry }).invoke(
    "mysql.primary.users.list",
    { tenantId: 9, limit: 25 },
    { correlationId: "corr-mysql-retry", actor: "agent-mysql" },
  );
  assert.equal(readResult.status, "executed");
  assert.equal(readCalls, 2);

  let writeCalls = 0;
  const writeRuntime = fakeRuntime(async () => {
    writeCalls += 1;
    const error = new Error("connection lost") as Error & { code: string };
    error.code = "PROTOCOL_CONNECTION_LOST";
    throw error;
  });
  const { registry: writeRegistry } = register(writeRuntime, [writeProfile]);
  const writeResult = await new BridgeRuntime({
    registry: writeRegistry,
    policy: allowPolicy,
  }).invoke(
    "mysql.primary.users.update-status",
    { status: "disabled", tenantId: 9, userId: 7 },
    { correlationId: "corr-mysql-no-retry", actor: "approved-agent" },
  );
  assert.equal(writeResult.status, "failed");
  assert.equal(writeCalls, 1);
});

test("READ result row bound is enforced", async () => {
  const boundedProfile: MySqlProfile = { ...readProfile, maxRows: 2 };
  const runtime = fakeRuntime(async () => ({
    kind: "rows",
    rows: [{ id: 1 }, { id: 2 }, { id: 3 }],
  }));
  const { registry } = register(runtime, [boundedProfile]);

  const result = await new BridgeRuntime({ registry }).invoke(
    "mysql.primary.users.list",
    { tenantId: 9, limit: 25 },
    { correlationId: "corr-mysql-bound", actor: "agent-mysql" },
  );

  assert.equal(result.status, "failed");
  if (result.status === "failed") assert.match(result.error, /2-row result bound/);
});

test("TLS disable requires explicit deployment opt-in and host allowlist is enforced", async () => {
  const runtime = fakeRuntime(async () => ({ kind: "rows", rows: [] }));
  const connector = createMySqlConnector(
    { profiles: [readProfile], allowedHosts: ["db.example.com"] },
    runtime,
  );
  const registry = new ToolRegistry();
  new ConnectorRegistryAdapter(registry).register({
    instanceId: "primary",
    connector,
    config: { ...config, tlsMode: "disabled" },
    secrets,
  });
  const disabled = await new BridgeRuntime({ registry }).invoke(
    "mysql.primary.users.list",
    { tenantId: 9, limit: 25 },
    { correlationId: "corr-mysql-tls", actor: "agent-mysql" },
  );
  assert.equal(disabled.status, "failed");

  const otherRegistry = new ToolRegistry();
  new ConnectorRegistryAdapter(otherRegistry).register({
    instanceId: "primary",
    connector,
    config: { ...config, host: "evil.example.net" },
    secrets,
  });
  const host = await new BridgeRuntime({ registry: otherRegistry }).invoke(
    "mysql.primary.users.list",
    { tenantId: 9, limit: 25 },
    { correlationId: "corr-mysql-host", actor: "agent-mysql" },
  );
  assert.equal(host.status, "failed");
});

test("profile registration rejects unsafe SQL and incomplete ES/EN metadata", () => {
  const runtime = fakeRuntime(async () => ({ kind: "rows", rows: [] }));

  assert.throws(
    () =>
      createMySqlConnector(
        {
          profiles: [
            {
              ...readProfile,
              id: "unsafe.read",
              statement: "SELECT id FROM users WHERE tenant_id = ?",
            },
          ],
        },
        runtime,
      ),
    /must declare a LIMIT/i,
  );

  assert.throws(
    () =>
      createMySqlConnector(
        {
          profiles: [
            {
              ...writeProfile,
              id: "unsafe.delete",
              statement: "DELETE FROM users WHERE id = ?",
              parameters: [{ id: "userId", type: "integer" }],
            },
          ],
        },
        runtime,
      ),
    /DELETE.*CRITICAL/i,
  );

  assert.throws(
    () =>
      createMySqlConnector(
        {
          profiles: [
            {
              ...readProfile,
              id: "unsafe.multi",
              statement: "SELECT id FROM users LIMIT 1; DROP TABLE users",
              parameters: [],
            },
          ],
        },
        runtime,
      ),
    /multiple statements|prohibited/i,
  );

  assert.throws(
    () =>
      createMySqlConnector(
        {
          profiles: [
            {
              ...readProfile,
              id: "unsafe.locale",
              localizations: {
                en: readProfile.localizations.en,
              },
            },
          ],
        },
        runtime,
      ),
    /requires ES name and description/i,
  );

  assert.throws(
    () =>
      createMySqlConnector(
        {
          profiles: [
            {
              ...readProfile,
              id: "unsafe.placeholders",
              parameters: readProfile.parameters.slice(0, 2),
            },
          ],
        },
        runtime,
      ),
    /parameters for 3 placeholders/i,
  );
});

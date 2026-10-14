import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BridgeRuntime,
  ConnectorRegistryAdapter,
  McpToolAdapter,
  ToolRegistry,
  createFilesConnector,
  createMySqlConnector,
  createPrestaShopConnector,
  createWooCommerceConnector,
  type AuditEvent,
  type GenericRestHttpRuntime,
  type MySqlProfile,
  type MySqlRuntime,
} from "../../src/index.js";

const readProfile: MySqlProfile = {
  id: "catalog.get",
  name: "Get catalog item",
  description: "Get one catalog item through a declared MySQL profile.",
  localizations: {
    en: {
      name: "Get MySQL catalog item",
      description: "Get one catalog item through a declared MySQL profile.",
    },
    es: {
      name: "Obtener elemento de catálogo MySQL",
      description: "Obtiene un elemento de catálogo mediante un perfil MySQL declarado.",
    },
  },
  risk: "READ",
  statement: "SELECT id, name FROM catalog WHERE id = ? LIMIT 1",
  parameters: [{ id: "itemId", type: "integer", minimum: 1 }],
  maxRows: 1,
};

const criticalProfile: MySqlProfile = {
  id: "catalog.delete",
  name: "Delete catalog item",
  description: "Delete one catalog item through a declared MySQL profile.",
  localizations: {
    en: {
      name: "Delete MySQL catalog item",
      description: "Delete one catalog item through a declared MySQL profile.",
    },
    es: {
      name: "Eliminar elemento de catálogo MySQL",
      description: "Elimina un elemento de catálogo mediante un perfil MySQL declarado.",
    },
  },
  risk: "CRITICAL",
  statement: "DELETE FROM catalog WHERE id = ?",
  parameters: [{ id: "itemId", type: "integer", minimum: 1 }],
  idempotency: { mode: "intrinsic" },
};

test("Phase 4: WooCommerce, PrestaShop, MySQL and Files coexist under one policy/audit/discovery core", async (t) => {
  const temp = await mkdtemp(path.join(tmpdir(), "kab-phase4-"));
  t.after(async () => {
    await rm(temp, { recursive: true, force: true });
  });
  await writeFile(path.join(temp, "note.txt"), "phase4", "utf8");

  let wooHttpCalls = 0;
  let prestaHttpCalls = 0;
  let mysqlReadCalls = 0;
  let mysqlMutationCalls = 0;

  const wooHttp: GenericRestHttpRuntime = {
    async resolveHost() {
      return ["93.184.216.34"];
    },
    async fetch(input, init) {
      wooHttpCalls += 1;
      const url = new URL(input);
      assert.equal(init.method, "GET");
      assert.equal(url.pathname, "/wp-json/wc/v3/orders/101");
      return new Response(
        JSON.stringify({ id: 101, status: "processing", total: "39.90" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  };

  const prestaHttp: GenericRestHttpRuntime = {
    async resolveHost() {
      return ["93.184.216.34"];
    },
    async fetch(input, init) {
      prestaHttpCalls += 1;
      const url = new URL(input);
      assert.equal(init.method, "GET");
      assert.equal(url.pathname, "/api/products/27");
      return new Response(
        JSON.stringify({ product: { id: 27, reference: "REF-27", active: "1" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  };

  const mysqlRuntime: MySqlRuntime = {
    async execute(_settings, request) {
      if (request.mode === "read") {
        mysqlReadCalls += 1;
        assert.equal(request.statement, readProfile.statement);
        assert.deepEqual(request.values, [27]);
        return { kind: "rows", rows: [{ id: 27, name: "Database item" }] };
      }
      mysqlMutationCalls += 1;
      return { kind: "mutation", affectedRows: 1, changedRows: 1 };
    },
    async health() {},
  };

  const registry = new ToolRegistry();
  const adapter = new ConnectorRegistryAdapter(registry, { sleep: async () => {} });

  adapter.register({
    instanceId: "woo",
    connector: createWooCommerceConnector({}, wooHttp),
    config: { baseUrl: "https://woo.example.com" },
    secrets: {
      async getSecret(requirementId, fieldId) {
        assert.equal(requirementId, "woocommerce_api");
        if (fieldId === "consumer_key") return "ck_phase4";
        if (fieldId === "consumer_secret") return "cs_phase4";
        return null;
      },
    },
  });

  adapter.register({
    instanceId: "ps",
    connector: createPrestaShopConnector({}, prestaHttp),
    config: { baseUrl: "https://presta.example.com" },
    secrets: {
      async getSecret(requirementId, fieldId) {
        assert.equal(requirementId, "prestashop_webservice");
        return fieldId === "webservice_key" ? "PS_PHASE4_KEY" : null;
      },
    },
  });

  adapter.register({
    instanceId: "primary",
    connector: createMySqlConnector(
      {
        profiles: [readProfile, criticalProfile],
        allowedHosts: ["db.example.com"],
      },
      mysqlRuntime,
    ),
    config: {
      host: "db.example.com",
      port: 3306,
      database: "appdb",
      tlsMode: "verify",
    },
    secrets: {
      async getSecret(requirementId, fieldId) {
        assert.equal(requirementId, "mysql_auth");
        if (fieldId === "username") return "bridge_user";
        if (fieldId === "password") return "bridge_password";
        return null;
      },
    },
  });

  adapter.register({
    instanceId: "local",
    connector: createFilesConnector({
      roots: [
        {
          id: "docs",
          path: temp,
          name: "Documents",
          description: "Phase 4 acceptance document root.",
          localizations: {
            en: {
              name: "Documents",
              description: "Phase 4 acceptance document root.",
            },
            es: {
              name: "Documentos",
              description: "Root de documentos para la aceptación de Phase 4.",
            },
          },
          access: "full",
        },
      ],
    }),
    config: {},
    secrets: {
      async getSecret() {
        return null;
      },
    },
  });

  const auditEvents: AuditEvent[] = [];
  const runtime = new BridgeRuntime({
    registry,
    audit: {
      async emit(event) {
        auditEvents.push(event);
      },
    },
  });

  const wooRead = await runtime.invoke(
    "woocommerce.woo.orders.get",
    { orderId: 101 },
    { correlationId: "phase4-woo-read", actor: "phase4-agent" },
  );
  const prestaRead = await runtime.invoke(
    "prestashop.ps.products.get",
    { productId: 27 },
    { correlationId: "phase4-presta-read", actor: "phase4-agent" },
  );
  const mysqlRead = await runtime.invoke(
    "mysql.primary.catalog.get",
    { itemId: 27 },
    { correlationId: "phase4-mysql-read", actor: "phase4-agent" },
  );
  const fileRead = await runtime.invoke(
    "files.local.docs.read",
    { path: "note.txt" },
    { correlationId: "phase4-files-read", actor: "phase4-agent" },
  );

  assert.equal(wooRead.status, "executed");
  assert.equal(prestaRead.status, "executed");
  assert.equal(mysqlRead.status, "executed");
  assert.equal(fileRead.status, "executed");
  assert.equal(wooHttpCalls, 1);
  assert.equal(prestaHttpCalls, 1);
  assert.equal(mysqlReadCalls, 1);
  if (fileRead.status === "executed") {
    assert.equal((fileRead.output as { content: string }).content, "phase4");
  }

  const wooWrite = await runtime.invoke(
    "woocommerce.woo.orders.update-status",
    { orderId: 101, status: "completed" },
    { correlationId: "phase4-woo-write", actor: "phase4-agent" },
  );
  const prestaWrite = await runtime.invoke(
    "prestashop.ps.orders.update-status",
    { orderId: 42, orderStateId: 4 },
    { correlationId: "phase4-presta-write", actor: "phase4-agent" },
  );
  const mysqlCritical = await runtime.invoke(
    "mysql.primary.catalog.delete",
    { itemId: 27 },
    { correlationId: "phase4-mysql-critical", actor: "phase4-agent" },
  );
  const filesCritical = await runtime.invoke(
    "files.local.docs.delete",
    { path: "note.txt" },
    { correlationId: "phase4-files-critical", actor: "phase4-agent" },
  );

  assert.equal(wooWrite.status, "approval_required");
  assert.equal(prestaWrite.status, "approval_required");
  assert.equal(mysqlCritical.status, "approval_required");
  assert.equal(filesCritical.status, "approval_required");
  assert.equal(wooHttpCalls, 1);
  assert.equal(prestaHttpCalls, 1);
  assert.equal(mysqlMutationCalls, 0);
  assert.equal(await readFile(path.join(temp, "note.txt"), "utf8"), "phase4");

  const mcp = new McpToolAdapter(runtime);
  const es = mcp.listTools("es");
  const en = mcp.listTools("en");
  const esNames = es.tools.map((tool) => tool.name);
  const enNames = en.tools.map((tool) => tool.name);

  assert.deepEqual(esNames, enNames);
  assert.equal(new Set(esNames).size, esNames.length);
  assert.equal(esNames.length, registry.list().length);
  assert.ok(esNames.includes("woocommerce.woo.orders.get"));
  assert.ok(esNames.includes("prestashop.ps.products.get"));
  assert.ok(esNames.includes("mysql.primary.catalog.get"));
  assert.ok(esNames.includes("files.local.docs.read"));

  assert.equal(
    mcp.getTool("woocommerce.woo.orders.get", "es")?.title,
    "Obtener pedido de WooCommerce",
  );
  assert.equal(
    mcp.getTool("prestashop.ps.products.get", "en")?.title,
    "Get PrestaShop product",
  );
  assert.equal(
    mcp.getTool("mysql.primary.catalog.get", "es")?.title,
    "Obtener elemento de catálogo MySQL",
  );
  assert.equal(
    mcp.getTool("files.local.docs.read", "en")?.title,
    "Read file from Documents",
  );

  const auditedTools = new Set(auditEvents.map((event) => event.toolId));
  assert.ok(auditedTools.has("woocommerce.woo.orders.get"));
  assert.ok(auditedTools.has("prestashop.ps.products.get"));
  assert.ok(auditedTools.has("mysql.primary.catalog.get"));
  assert.ok(auditedTools.has("files.local.docs.read"));
  assert.ok(auditedTools.has("woocommerce.woo.orders.update-status"));
  assert.ok(auditedTools.has("prestashop.ps.orders.update-status"));
  assert.ok(auditedTools.has("mysql.primary.catalog.delete"));
  assert.ok(auditedTools.has("files.local.docs.delete"));
});

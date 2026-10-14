import assert from "node:assert/strict";
import test from "node:test";

import {
  BridgeRuntime,
  ConnectorRegistryAdapter,
  McpToolAdapter,
  ToolRegistry,
  createPrestaShopConnector,
  type GenericRestHttpRuntime,
} from "../../src/index.js";

const webserviceKey = "PSKEY12345678901234567890123456";

const secrets = {
  async getSecret(requirementId: string, fieldId: string): Promise<string | null> {
    assert.equal(requirementId, "prestashop_webservice");
    assert.equal(fieldId, "webservice_key");
    return webserviceKey;
  },
};

function register(http: GenericRestHttpRuntime, baseUrl = "https://shop.example.com") {
  const registry = new ToolRegistry();
  const connector = createPrestaShopConnector({}, http);
  new ConnectorRegistryAdapter(registry).register({
    instanceId: "store",
    connector,
    config: { baseUrl },
    secrets,
  });
  return { registry, connector };
}

test("PrestaShop connector exposes six READ and two WRITE tools with ES/EN metadata", () => {
  const connector = createPrestaShopConnector();
  assert.equal(connector.manifest.id, "prestashop");
  assert.equal(connector.tools.length, 8);
  assert.equal(connector.tools.filter((tool) => tool.risk === "READ").length, 6);
  assert.equal(connector.tools.filter((tool) => tool.risk === "WRITE").length, 2);
  assert.deepEqual(connector.manifest.capabilities, [
    "orders.read",
    "orders.write",
    "order-states.read",
    "products.read",
    "stock.read",
    "stock.write",
  ]);
  assert.match(
    connector.manifest.localizations?.es?.description ?? "",
    /pedidos, productos y StockAvailable/i,
  );
  assert.match(
    connector.manifest.localizations?.en?.description ?? "",
    /orders, products and StockAvailable/i,
  );

  const credential = connector.manifest.credentials[0];
  assert.equal(credential?.fields[0]?.secret, true);
  assert.match(credential?.localizations?.es?.label ?? "", /Clave del Webservice/i);
  assert.match(credential?.localizations?.en?.label ?? "", /Webservice key/i);
});

test("PrestaShop orders.list preserves subfolder prefix and uses API-key Basic Auth", async () => {
  let seenUrl = "";
  let seenAuth: string | null = null;
  const http: GenericRestHttpRuntime = {
    async resolveHost() {
      return ["93.184.216.34"];
    },
    async fetch(input, init) {
      seenUrl = input;
      seenAuth = new Headers(init.headers).get("authorization");
      return new Response(
        JSON.stringify({ orders: [{ id: 10, id_customer: 4, current_state: 2 }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  };
  const { registry } = register(http, "https://shop.example.com/prestashop");

  const result = await new BridgeRuntime({ registry }).invoke(
    "prestashop.store.orders.list",
    { offset: 20, limit: 25, customerId: 4, currentState: 2 },
    { correlationId: "corr-ps-orders", actor: "agent-ps" },
  );

  assert.equal(result.status, "executed");
  const url = new URL(seenUrl);
  assert.equal(url.pathname, "/prestashop/api/orders");
  assert.equal(url.searchParams.get("output_format"), "JSON");
  assert.equal(url.searchParams.get("display"), "full");
  assert.equal(url.searchParams.get("limit"), "20,25");
  assert.equal(url.searchParams.get("filter[id_customer]"), "[4]");
  assert.equal(url.searchParams.get("filter[current_state]"), "[2]");
  assert.equal(
    seenAuth,
    `Basic ${Buffer.from(`${webserviceKey}:`, "utf8").toString("base64")}`,
  );
});

test("PrestaShop order response redacts secure_key recursively", async () => {
  const http: GenericRestHttpRuntime = {
    async resolveHost() {
      return ["93.184.216.34"];
    },
    async fetch(input) {
      assert.equal(new URL(input).pathname, "/api/orders/10");
      return new Response(
        JSON.stringify({
          order: {
            id: 10,
            secure_key: "must-not-leak",
            associations: { nested: { token: "also-secret" } },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  };
  const { registry } = register(http);
  const result = await new BridgeRuntime({ registry }).invoke(
    "prestashop.store.orders.get",
    { orderId: 10 },
    { correlationId: "corr-ps-order", actor: "agent-ps" },
  );

  assert.equal(result.status, "executed");
  if (result.status === "executed") {
    assert.deepEqual(result.output, {
      status: 200,
      ok: true,
      body: {
        order: {
          id: 10,
          secure_key: "[REDACTED]",
          associations: { nested: { token: "[REDACTED]" } },
        },
      },
    });
  }
});

test("PrestaShop order-states.list exposes configured order state IDs", async () => {
  let seenUrl = "";
  const http: GenericRestHttpRuntime = {
    async resolveHost() {
      return ["93.184.216.34"];
    },
    async fetch(input) {
      seenUrl = input;
      return new Response(
        JSON.stringify({ order_states: [{ id: 2, name: "Payment accepted" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  };
  const { registry } = register(http);
  const result = await new BridgeRuntime({ registry }).invoke(
    "prestashop.store.order-states.list",
    { offset: 0, limit: 25 },
    { correlationId: "corr-ps-states", actor: "agent-ps" },
  );

  assert.equal(result.status, "executed");
  const url = new URL(seenUrl);
  assert.equal(url.pathname, "/api/order_states");
  assert.equal(url.searchParams.get("display"), "full");
  assert.equal(url.searchParams.get("limit"), "0,25");
});

test("PrestaShop stock.get-by-product queries StockAvailable with controlled filters", async () => {
  let seenUrl = "";
  const http: GenericRestHttpRuntime = {
    async resolveHost() {
      return ["93.184.216.34"];
    },
    async fetch(input) {
      seenUrl = input;
      return new Response(
        JSON.stringify({
          stock_availables: [
            { id: 88, id_product: 27, id_product_attribute: 3, quantity: 12 },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  };
  const { registry } = register(http);
  const result = await new BridgeRuntime({ registry }).invoke(
    "prestashop.store.stock.get-by-product",
    { productId: 27, productAttributeId: 3 },
    { correlationId: "corr-ps-stock", actor: "agent-ps" },
  );

  assert.equal(result.status, "executed");
  const url = new URL(seenUrl);
  assert.equal(url.pathname, "/api/stock_availables");
  assert.equal(url.searchParams.get("filter[id_product]"), "[27]");
  assert.equal(url.searchParams.get("filter[id_product_attribute]"), "[3]");
  assert.equal(url.searchParams.get("display"), "full");
  assert.equal(url.searchParams.get("output_format"), "JSON");
});

test("PrestaShop input validation rejects unknown fields before HTTP", async () => {
  let httpCalls = 0;
  const http: GenericRestHttpRuntime = {
    async resolveHost() {
      return ["93.184.216.34"];
    },
    async fetch() {
      httpCalls += 1;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
  const { registry } = register(http);
  const result = await new BridgeRuntime({ registry }).invoke(
    "prestashop.store.products.list",
    { limit: 25, sql: "DROP TABLE ps_product" },
    { correlationId: "corr-ps-invalid", actor: "agent-ps" },
  );

  assert.equal(result.status, "failed");
  assert.equal(httpCalls, 0);
});

test("PrestaShop MCP discovery is localized ES/EN", () => {
  const http: GenericRestHttpRuntime = {
    async resolveHost() {
      return ["93.184.216.34"];
    },
    async fetch() {
      throw new Error("not used");
    },
  };
  const { registry } = register(http);
  const mcp = new McpToolAdapter(new BridgeRuntime({ registry }));

  assert.equal(
    mcp.getTool("prestashop.store.stock.get-by-product", "es")?.title,
    "Obtener stock de PrestaShop por producto",
  );
  assert.equal(
    mcp.getTool("prestashop.store.stock.get-by-product", "en")?.title,
    "Get PrestaShop stock by product",
  );
  assert.equal(
    mcp.getTool("prestashop.store.order-states.list", "es")?.title,
    "Listar estados de pedido de PrestaShop",
  );
  assert.equal(
    mcp.getTool("prestashop.store.order-states.list", "en")?.title,
    "List PrestaShop order states",
  );
});

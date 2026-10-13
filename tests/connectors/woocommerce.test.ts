import assert from "node:assert/strict";
import test from "node:test";

import {
  BridgeRuntime,
  ConnectorRegistryAdapter,
  McpToolAdapter,
  ToolRegistry,
  createWooCommerceConnector,
  type ConnectorInstance,
  type GenericRestHttpRuntime,
} from "../../src/index.js";

const consumerKey = "ck_test_123";
const consumerSecret = "cs_test_456";

function secretProvider() {
  return {
    async getSecret(requirementId: string, fieldId: string): Promise<string | null> {
      assert.equal(requirementId, "woocommerce_api");
      if (fieldId === "consumer_key") return consumerKey;
      if (fieldId === "consumer_secret") return consumerSecret;
      return null;
    },
  };
}

test("WooCommerce connector exposes four READ and two WRITE tools with ES/EN discovery", () => {
  const connector = createWooCommerceConnector();

  assert.equal(connector.manifest.id, "woocommerce");
  assert.deepEqual(connector.manifest.capabilities, [
    "orders.read",
    "orders.write",
    "products.read",
    "products.write",
    "stock.read",
    "stock.write",
  ]);
  assert.equal(connector.tools.length, 6);
  assert.equal(connector.tools.filter((tool) => tool.risk === "READ").length, 4);
  assert.equal(connector.tools.filter((tool) => tool.risk === "WRITE").length, 2);

  const registry = new ToolRegistry();
  const instance: ConnectorInstance = {
    instanceId: "store",
    connector,
    config: { baseUrl: "https://shop.example.com" },
    secrets: secretProvider(),
  };
  new ConnectorRegistryAdapter(registry).register(instance);
  const mcp = new McpToolAdapter(new BridgeRuntime({ registry }));

  const es = mcp.getTool("woocommerce.store.orders.get", "es");
  const en = mcp.getTool("woocommerce.store.orders.get", "en");

  assert.equal(es?.title, "Obtener pedido de WooCommerce");
  assert.equal(en?.title, "Get WooCommerce order");
  assert.match(es?.description ?? "", /pedido de WooCommerce/i);
  assert.match(en?.description ?? "", /WooCommerce order/i);
});

test("WooCommerce orders.list uses WC REST v3, controlled filters and Basic credentials from SecretProvider", async () => {
  const seen: { url?: string; authorization?: string | null } = {};
  const http: GenericRestHttpRuntime = {
    async resolveHost() {
      return ["93.184.216.34"];
    },
    async fetch(input, init) {
      seen.url = input;
      seen.authorization = new Headers(init.headers).get("authorization");
      return new Response(
        JSON.stringify([
          { id: 101, status: "processing", total: "59.90" },
          { id: 102, status: "on-hold", total: "20.00" },
        ]),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    },
  };

  const connector = createWooCommerceConnector({}, http);
  const registry = new ToolRegistry();
  new ConnectorRegistryAdapter(registry).register({
    instanceId: "store",
    connector,
    config: { baseUrl: "https://shop.example.com" },
    secrets: secretProvider(),
  });

  const result = await new BridgeRuntime({ registry }).invoke(
    "woocommerce.store.orders.list",
    {
      page: 2,
      perPage: 20,
      status: ["processing", "on-hold"],
      customerId: 9,
    },
    {
      correlationId: "corr-woo-orders",
      actor: "agent-woo",
      tenantId: "tenant-woo",
      installationId: "installation-woo",
    },
  );

  assert.equal(result.status, "executed");
  assert.ok(seen.url);
  const url = new URL(seen.url);
  assert.equal(url.pathname, "/wp-json/wc/v3/orders");
  assert.equal(url.searchParams.get("page"), "2");
  assert.equal(url.searchParams.get("per_page"), "20");
  assert.deepEqual(url.searchParams.getAll("status"), ["processing", "on-hold"]);
  assert.equal(url.searchParams.get("customer"), "9");
  assert.equal(
    seen.authorization,
    `Basic ${Buffer.from(`${consumerKey}:${consumerSecret}`, "utf8").toString("base64")}`,
  );

  if (result.status === "executed") {
    assert.deepEqual(result.output, {
      status: 200,
      ok: true,
      body: [
        { id: 101, status: "processing", total: "59.90" },
        { id: 102, status: "on-hold", total: "20.00" },
      ],
    });
  }
});

test("WooCommerce products.get preserves stock fields and never embeds credential values in connector metadata", async () => {
  const http: GenericRestHttpRuntime = {
    async resolveHost() {
      return ["93.184.216.34"];
    },
    async fetch(input) {
      const url = new URL(input);
      assert.equal(url.pathname, "/wp-json/wc/v3/products/77");
      return new Response(
        JSON.stringify({
          id: 77,
          name: "Demo product",
          manage_stock: true,
          stock_quantity: 8,
          stock_status: "instock",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    },
  };

  const connector = createWooCommerceConnector({}, http);
  assert.doesNotMatch(JSON.stringify(connector.manifest), /ck_test_123|cs_test_456/);

  const registry = new ToolRegistry();
  new ConnectorRegistryAdapter(registry).register({
    instanceId: "store",
    connector,
    config: { baseUrl: "https://shop.example.com" },
    secrets: secretProvider(),
  });

  const result = await new BridgeRuntime({ registry }).invoke(
    "woocommerce.store.products.get",
    { productId: 77 },
    {
      correlationId: "corr-woo-product",
      actor: "agent-woo",
    },
  );

  assert.equal(result.status, "executed");
  if (result.status === "executed") {
    assert.deepEqual(result.output, {
      status: 200,
      ok: true,
      body: {
        id: 77,
        name: "Demo product",
        manage_stock: true,
        stock_quantity: 8,
        stock_status: "instock",
      },
    });
  }
});

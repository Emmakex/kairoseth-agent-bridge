import assert from "node:assert/strict";
import test from "node:test";

import {
  BridgeRuntime,
  ConnectorRegistryAdapter,
  McpToolAdapter,
  ToolRegistry,
  createWooCommerceConnector,
  type GenericRestHttpRuntime,
  type PolicyEvaluator,
} from "../../src/index.js";

const secrets = {
  async getSecret(requirementId: string, fieldId: string): Promise<string | null> {
    if (requirementId !== "woocommerce_api") return null;
    if (fieldId === "consumer_key") return "ck_write_test";
    if (fieldId === "consumer_secret") return "cs_write_test";
    return null;
  },
};

const allowPolicy: PolicyEvaluator = {
  async evaluate() {
    return { outcome: "ALLOW", reason: "approved by test policy" };
  },
};

function registerConnector(http: GenericRestHttpRuntime) {
  const registry = new ToolRegistry();
  const connector = createWooCommerceConnector({}, http);
  new ConnectorRegistryAdapter(registry).register({
    instanceId: "store",
    connector,
    config: { baseUrl: "https://shop.example.com" },
    secrets,
  });
  return { registry, connector };
}

test("WooCommerce WRITE tools require approval before any HTTP mutation", async () => {
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
  const { registry } = registerConnector(http);
  const runtime = new BridgeRuntime({ registry });

  const order = await runtime.invoke(
    "woocommerce.store.orders.update-status",
    { orderId: 42, status: "completed" },
    { correlationId: "corr-order-write", actor: "agent-woo" },
  );
  const stock = await runtime.invoke(
    "woocommerce.store.products.update-stock",
    { productId: 77, stockQuantity: 8 },
    { correlationId: "corr-stock-write", actor: "agent-woo" },
  );

  assert.equal(order.status, "approval_required");
  assert.equal(stock.status, "approval_required");
  assert.equal(httpCalls, 0);
});

test("approved order status update sends only the allowlisted status payload", async () => {
  let seenMethod = "";
  let seenPath = "";
  let seenBody = "";
  const http: GenericRestHttpRuntime = {
    async resolveHost() {
      return ["93.184.216.34"];
    },
    async fetch(input, init) {
      seenMethod = init.method ?? "";
      seenPath = new URL(input).pathname;
      seenBody = String(init.body ?? "");
      return new Response(JSON.stringify({ id: 42, status: "completed" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
  const { registry } = registerConnector(http);
  const runtime = new BridgeRuntime({ registry, policy: allowPolicy });

  const result = await runtime.invoke(
    "woocommerce.store.orders.update-status",
    { orderId: 42, status: "completed" },
    { correlationId: "corr-order-allow", actor: "approved-agent" },
  );

  assert.equal(result.status, "executed");
  assert.equal(seenMethod, "PUT");
  assert.equal(seenPath, "/wp-json/wc/v3/orders/42");
  assert.deepEqual(JSON.parse(seenBody), { status: "completed" });
});

test("approved stock update maps only allowlisted fields to WooCommerce names", async () => {
  let seenBody = "";
  let seenPath = "";
  const http: GenericRestHttpRuntime = {
    async resolveHost() {
      return ["93.184.216.34"];
    },
    async fetch(input, init) {
      seenPath = new URL(input).pathname;
      seenBody = String(init.body ?? "");
      return new Response(
        JSON.stringify({
          id: 77,
          manage_stock: true,
          stock_quantity: 8,
          stock_status: "instock",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  };
  const { registry } = registerConnector(http);
  const runtime = new BridgeRuntime({ registry, policy: allowPolicy });

  const result = await runtime.invoke(
    "woocommerce.store.products.update-stock",
    {
      productId: 77,
      manageStock: true,
      stockQuantity: 8,
      stockStatus: "instock",
    },
    { correlationId: "corr-stock-allow", actor: "approved-agent" },
  );

  assert.equal(result.status, "executed");
  assert.equal(seenPath, "/wp-json/wc/v3/products/77");
  assert.deepEqual(JSON.parse(seenBody), {
    manage_stock: true,
    stock_quantity: 8,
    stock_status: "instock",
  });
});

test("WooCommerce write input rejects unsupported fields and unsafe values before HTTP", async () => {
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
  const { registry } = registerConnector(http);
  const runtime = new BridgeRuntime({ registry, policy: allowPolicy });

  const unsafeOrder = await runtime.invoke(
    "woocommerce.store.orders.update-status",
    { orderId: 42, status: "trash" },
    { correlationId: "corr-order-invalid", actor: "agent-woo" },
  );
  const arbitraryProduct = await runtime.invoke(
    "woocommerce.store.products.update-stock",
    { productId: 77, stockQuantity: 8, regularPrice: "0.01" },
    { correlationId: "corr-stock-extra", actor: "agent-woo" },
  );
  const emptyStock = await runtime.invoke(
    "woocommerce.store.products.update-stock",
    { productId: 77 },
    { correlationId: "corr-stock-empty", actor: "agent-woo" },
  );
  const negativeStock = await runtime.invoke(
    "woocommerce.store.products.update-stock",
    { productId: 77, stockQuantity: -1 },
    { correlationId: "corr-stock-negative", actor: "agent-woo" },
  );

  assert.equal(unsafeOrder.status, "failed");
  assert.equal(arbitraryProduct.status, "failed");
  assert.equal(emptyStock.status, "failed");
  assert.equal(negativeStock.status, "failed");
  assert.equal(httpCalls, 0);
});

test("WooCommerce WRITE metadata is ES/EN, intrinsic-idempotent and never auto-retried", () => {
  const http: GenericRestHttpRuntime = {
    async resolveHost() {
      return ["93.184.216.34"];
    },
    async fetch() {
      throw new Error("not used");
    },
  };
  const { registry, connector } = registerConnector(http);
  const order = connector.tools.find((tool) => tool.id === "orders.update-status");
  const stock = connector.tools.find((tool) => tool.id === "products.update-stock");

  assert.equal(order?.risk, "WRITE");
  assert.equal(stock?.risk, "WRITE");
  assert.equal(order?.behavior?.retry?.mode, "never");
  assert.equal(stock?.behavior?.retry?.mode, "never");
  assert.equal(order?.behavior?.idempotency?.mode, "intrinsic");
  assert.equal(stock?.behavior?.idempotency?.mode, "intrinsic");

  const mcp = new McpToolAdapter(new BridgeRuntime({ registry }));
  assert.equal(
    mcp.getTool("woocommerce.store.orders.update-status", "es")?.title,
    "Actualizar estado de pedido de WooCommerce",
  );
  assert.equal(
    mcp.getTool("woocommerce.store.orders.update-status", "en")?.title,
    "Update WooCommerce order status",
  );
  assert.equal(
    mcp.getTool("woocommerce.store.products.update-stock", "es")?.title,
    "Actualizar stock de producto de WooCommerce",
  );
  assert.equal(
    mcp.getTool("woocommerce.store.products.update-stock", "en")?.title,
    "Update WooCommerce product stock",
  );
});

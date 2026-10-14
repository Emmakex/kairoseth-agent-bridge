import assert from "node:assert/strict";
import test from "node:test";

import {
  BridgeRuntime,
  ConnectorRegistryAdapter,
  McpToolAdapter,
  ToolRegistry,
  createPrestaShopConnector,
  type GenericRestHttpRuntime,
  type PolicyEvaluator,
} from "../../src/index.js";

const webserviceKey = "PSKEY12345678901234567890123456";

const secrets = {
  async getSecret(requirementId: string, fieldId: string): Promise<string | null> {
    if (requirementId !== "prestashop_webservice") return null;
    if (fieldId === "webservice_key") return webserviceKey;
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
  const connector = createPrestaShopConnector({}, http);
  new ConnectorRegistryAdapter(registry).register({
    instanceId: "store",
    connector,
    config: { baseUrl: "https://shop.example.com" },
    secrets,
  });
  return { registry, connector };
}

test("PrestaShop WRITE tools require approval before any HTTP mutation", async () => {
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
    "prestashop.store.orders.update-status",
    { orderId: 42, orderStateId: 4, sendEmail: false },
    { correlationId: "corr-ps-order-write", actor: "agent-ps" },
  );
  const stock = await runtime.invoke(
    "prestashop.store.stock.update-quantity",
    { stockAvailableId: 88, productId: 27, productAttributeId: 3, quantity: 8 },
    { correlationId: "corr-ps-stock-write", actor: "agent-ps" },
  );

  assert.equal(order.status, "approval_required");
  assert.equal(stock.status, "approval_required");
  assert.equal(httpCalls, 0);
});

test("approved order status update creates an OrderHistory transition with optional email", async () => {
  let seenMethod = "";
  let seenUrl = "";
  let seenBody = "";
  let seenContentType = "";
  let seenAuth = "";
  const http: GenericRestHttpRuntime = {
    async resolveHost() {
      return ["93.184.216.34"];
    },
    async fetch(input, init) {
      seenMethod = init.method ?? "";
      seenUrl = input;
      seenBody = String(init.body ?? "");
      const headers = new Headers(init.headers);
      seenContentType = headers.get("content-type") ?? "";
      seenAuth = headers.get("authorization") ?? "";
      return new Response(
        JSON.stringify({
          order_history: { id: 501, id_order: 42, id_order_state: 4 },
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    },
  };
  const { registry } = registerConnector(http);
  const runtime = new BridgeRuntime({ registry, policy: allowPolicy });

  const result = await runtime.invoke(
    "prestashop.store.orders.update-status",
    { orderId: 42, orderStateId: 4, sendEmail: true },
    { correlationId: "corr-ps-order-allow", actor: "approved-agent" },
  );

  assert.equal(result.status, "executed");
  assert.equal(seenMethod, "POST");
  const url = new URL(seenUrl);
  assert.equal(url.pathname, "/api/order_histories");
  assert.equal(url.searchParams.get("sendemail"), "1");
  assert.equal(url.searchParams.get("output_format"), "JSON");
  assert.match(seenContentType, /^application\/xml/i);
  assert.equal(
    seenAuth,
    `Basic ${Buffer.from(`${webserviceKey}:`, "utf8").toString("base64")}`,
  );
  assert.match(seenBody, /<id_order_state><!\[CDATA\[4\]\]><\/id_order_state>/);
  assert.match(seenBody, /<id_order><!\[CDATA\[42\]\]><\/id_order>/);
  assert.doesNotMatch(seenBody, /secure_key|customer|total_paid/i);
});

test("approved stock update verifies target then PATCHes only id and quantity", async () => {
  const calls: Array<{
    method: string;
    path: string;
    body: string;
    query: URLSearchParams;
  }> = [];
  const http: GenericRestHttpRuntime = {
    async resolveHost() {
      return ["93.184.216.34"];
    },
    async fetch(input, init) {
      const url = new URL(input);
      calls.push({
        method: init.method ?? "",
        path: url.pathname,
        body: String(init.body ?? ""),
        query: url.searchParams,
      });
      if ((init.method ?? "") === "GET") {
        return new Response(
          JSON.stringify({
            stock_available: {
              id: "88",
              id_product: "27",
              id_product_attribute: "3",
              quantity: "12",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          stock_available: {
            id: 88,
            id_product: 27,
            id_product_attribute: 3,
            quantity: 8,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  };
  const { registry } = registerConnector(http);
  const runtime = new BridgeRuntime({ registry, policy: allowPolicy });

  const result = await runtime.invoke(
    "prestashop.store.stock.update-quantity",
    { stockAvailableId: 88, productId: 27, productAttributeId: 3, quantity: 8 },
    { correlationId: "corr-ps-stock-allow", actor: "approved-agent" },
  );

  assert.equal(result.status, "executed");
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.method, "GET");
  assert.equal(calls[0]?.path, "/api/stock_availables/88");
  assert.equal(calls[1]?.method, "PATCH");
  assert.equal(calls[1]?.path, "/api/stock_availables/88");
  assert.equal(calls[1]?.query.get("output_format"), "JSON");
  assert.match(
    calls[1]?.body ?? "",
    /<stock_available><id><!\[CDATA\[88\]\]><\/id><quantity><!\[CDATA\[8\]\]><\/quantity><\/stock_available>/,
  );
  assert.doesNotMatch(
    calls[1]?.body ?? "",
    /id_product|id_product_attribute|depends_on_stock|out_of_stock/i,
  );
});

test("stock update refuses a mismatched StockAvailable target before PATCH", async () => {
  let patchCalls = 0;
  const http: GenericRestHttpRuntime = {
    async resolveHost() {
      return ["93.184.216.34"];
    },
    async fetch(_input, init) {
      if ((init.method ?? "") === "PATCH") patchCalls += 1;
      return new Response(
        JSON.stringify({
          stock_available: {
            id: 88,
            id_product: 999,
            id_product_attribute: 3,
            quantity: 12,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  };
  const { registry } = registerConnector(http);
  const runtime = new BridgeRuntime({ registry, policy: allowPolicy });

  const result = await runtime.invoke(
    "prestashop.store.stock.update-quantity",
    { stockAvailableId: 88, productId: 27, productAttributeId: 3, quantity: 8 },
    { correlationId: "corr-ps-stock-mismatch", actor: "approved-agent" },
  );

  assert.equal(result.status, "failed");
  assert.equal(patchCalls, 0);
  if (result.status === "failed") {
    assert.match(result.error, /does not belong to the expected product\/combination/i);
  }
});

test("PrestaShop write input rejects unsupported or unsafe values before HTTP", async () => {
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

  const arbitraryOrder = await runtime.invoke(
    "prestashop.store.orders.update-status",
    { orderId: 42, orderStateId: 4, note: "arbitrary" },
    { correlationId: "corr-ps-order-extra", actor: "agent-ps" },
  );
  const invalidState = await runtime.invoke(
    "prestashop.store.orders.update-status",
    { orderId: 42, orderStateId: 0 },
    { correlationId: "corr-ps-order-state", actor: "agent-ps" },
  );
  const arbitraryStock = await runtime.invoke(
    "prestashop.store.stock.update-quantity",
    { stockAvailableId: 88, productId: 27, quantity: 8, price: 1 },
    { correlationId: "corr-ps-stock-extra", actor: "agent-ps" },
  );
  const absurdStock = await runtime.invoke(
    "prestashop.store.stock.update-quantity",
    { stockAvailableId: 88, productId: 27, quantity: 1_000_000_000 },
    { correlationId: "corr-ps-stock-bound", actor: "agent-ps" },
  );

  assert.equal(arbitraryOrder.status, "failed");
  assert.equal(invalidState.status, "failed");
  assert.equal(arbitraryStock.status, "failed");
  assert.equal(absurdStock.status, "failed");
  assert.equal(httpCalls, 0);
});

test("PrestaShop WRITE metadata is ES/EN and never auto-retried", () => {
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
  const stock = connector.tools.find((tool) => tool.id === "stock.update-quantity");

  assert.equal(order?.risk, "WRITE");
  assert.equal(stock?.risk, "WRITE");
  assert.equal(order?.behavior?.retry?.mode, "never");
  assert.equal(stock?.behavior?.retry?.mode, "never");
  assert.equal(order?.behavior?.idempotency?.mode, "none");
  assert.equal(stock?.behavior?.idempotency?.mode, "intrinsic");

  const mcp = new McpToolAdapter(new BridgeRuntime({ registry }));
  assert.equal(
    mcp.getTool("prestashop.store.orders.update-status", "es")?.title,
    "Actualizar estado de pedido de PrestaShop",
  );
  assert.equal(
    mcp.getTool("prestashop.store.orders.update-status", "en")?.title,
    "Update PrestaShop order status",
  );
  assert.equal(
    mcp.getTool("prestashop.store.stock.update-quantity", "es")?.title,
    "Actualizar cantidad de stock de PrestaShop",
  );
  assert.equal(
    mcp.getTool("prestashop.store.stock.update-quantity", "en")?.title,
    "Update PrestaShop stock quantity",
  );
});

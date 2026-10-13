import assert from "node:assert/strict";
import test from "node:test";

import { createWooCommerceConnector } from "../../src/index.js";

test("WooCommerce official connector publishes ES/EN manifest and credential setup metadata", () => {
  const connector = createWooCommerceConnector();
  const credential = connector.manifest.credentials.find(
    (item) => item.id === "woocommerce_api",
  );

  assert.equal(connector.manifest.localizations?.en?.name, "WooCommerce");
  assert.equal(connector.manifest.localizations?.es?.name, "WooCommerce");
  assert.match(
    connector.manifest.localizations?.es?.description ?? "",
    /pedidos, productos y stock/i,
  );
  assert.match(
    connector.manifest.localizations?.en?.description ?? "",
    /orders, products and stock/i,
  );

  assert.ok(credential);
  assert.match(
    credential.localizations?.es?.label ?? "",
    /Credenciales de WooCommerce REST API/i,
  );
  assert.match(
    credential.localizations?.en?.label ?? "",
    /WooCommerce REST API credentials/i,
  );

  const consumerKey = credential.fields.find((field) => field.id === "consumer_key");
  const consumerSecret = credential.fields.find(
    (field) => field.id === "consumer_secret",
  );
  assert.equal(consumerKey?.secret, true);
  assert.equal(consumerSecret?.secret, true);
  assert.ok(consumerKey?.localizations?.es?.label);
  assert.ok(consumerKey?.localizations?.en?.label);
  assert.ok(consumerSecret?.localizations?.es?.label);
  assert.ok(consumerSecret?.localizations?.en?.label);
});

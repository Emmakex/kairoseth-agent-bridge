import assert from "node:assert/strict";
import test from "node:test";

import {
  buildConnectorInventory,
  type ConnectorDefinition,
  type ConnectorInstance,
  type ConnectorSecretProvider,
} from "../../src/index.js";

const secrets: ConnectorSecretProvider = {
  async getSecret() {
    return "super-secret-value";
  },
};

function connector(id: string, toolId: string): ConnectorDefinition {
  return {
    manifest: {
      id,
      name: `${id} connector`,
      version: "1.2.3",
      description: `${id} description`,
      localizations: {
        es: { name: `${id} ES`, description: `${id} descripción` },
        en: { name: `${id} EN`, description: `${id} description EN` },
      },
      capabilities: ["orders", "catalog"],
      credentials: [
        {
          id: "api",
          kind: "api_key",
          label: "API key",
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
        id: toolId,
        name: `${toolId} name`,
        description: `${toolId} description`,
        localizations: {
          es: { name: `${toolId} ES`, description: `${toolId} descripción` },
          en: { name: `${toolId} EN`, description: `${toolId} description EN` },
        },
        risk: "READ",
        inputSchema: { type: "object", additionalProperties: false },
        async execute() {
          return { ok: true };
        },
      },
    ],
  };
}

test("connector inventory is deterministic, localized and metadata-only", () => {
  const instances: ConnectorInstance[] = [
    {
      instanceId: "store-b",
      connector: connector("woocommerce", "orders.list"),
      config: {
        baseUrl: "https://private.customer.example",
        internalNote: "never-report-this",
      },
      secrets,
    },
    {
      instanceId: "shop-a",
      connector: connector("prestashop", "products.list"),
      config: { privatePath: "/srv/customer" },
      secrets,
    },
  ];

  const inventory = buildConnectorInventory(instances);

  assert.deepEqual(
    inventory.map((item) => `${item.connectorId}:${item.connectorInstanceId}`),
    ["prestashop:shop-a", "woocommerce:store-b"],
  );
  assert.deepEqual(inventory[0]?.capabilities, ["catalog", "orders"]);
  assert.equal(inventory[0]?.localizations?.es?.name, "prestashop ES");
  assert.equal(inventory[0]?.tools[0]?.localizations?.en?.name, "products.list EN");
  assert.equal(
    inventory[0]?.tools[0]?.runtimeToolId,
    "prestashop.shop-a.products.list",
  );

  const serialized = JSON.stringify(inventory);
  assert.doesNotMatch(serialized, /super-secret-value/);
  assert.doesNotMatch(serialized, /private\.customer\.example/);
  assert.doesNotMatch(serialized, /never-report-this/);
  assert.doesNotMatch(serialized, /privatePath/);
  assert.doesNotMatch(serialized, /credentials/);
  assert.doesNotMatch(serialized, /inputSchema/);
});

test("connector inventory keeps risk authoritative and does not imply execution permission", () => {
  const critical: ConnectorDefinition = {
    ...connector("custom-erp", "records.delete"),
    tools: [
      {
        id: "records.delete",
        name: "Delete record",
        description: "Delete an allowlisted record",
        risk: "CRITICAL",
        inputSchema: { type: "object" },
        async execute() {
          return { ok: true };
        },
      },
    ],
  };

  const [snapshot] = buildConnectorInventory([
    { instanceId: "erp-1", connector: critical, secrets },
  ]);

  assert.equal(snapshot?.tools[0]?.risk, "CRITICAL");
  assert.deepEqual(Object.keys(snapshot?.tools[0] ?? {}).sort(), [
    "description",
    "name",
    "risk",
    "runtimeToolId",
    "toolId",
  ]);
});

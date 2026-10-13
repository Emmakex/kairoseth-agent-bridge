import type { ToolLocalizations } from "../../core/contracts.js";
import {
  createGenericRestConnector,
} from "../generic-rest/factory.js";
import type {
  GenericRestHttpRuntime,
  GenericRestNetworkPolicy,
  GenericRestOperation,
} from "../generic-rest/contracts.js";
import { ConnectorError } from "../sdk/errors.js";
import type {
  ConnectorDefinition,
  ConnectorToolDefinition,
  JsonSchema,
} from "../sdk/contracts.js";

export interface WooCommerceConnectorOptions {
  /** Allow a private RFC1918/ULA destination only for a controlled local/on-prem runtime. */
  allowPrivateNetwork?: boolean | undefined;
  /** Optional exact origin allowlist, e.g. https://shop.example.com. */
  allowedOrigins?: readonly string[] | undefined;
  /** Maximum response bytes. Defaults to 2 MiB. Generic REST hard cap still applies. */
  maxResponseBytes?: number | undefined;
}

const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1_048_576;
const ORDER_STATUSES = new Set([
  "pending",
  "processing",
  "on-hold",
  "completed",
  "cancelled",
  "refunded",
  "failed",
]);
const STOCK_STATUSES = new Set(["instock", "outofstock", "onbackorder"]);

const ORDER_STATUS_INPUT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    orderId: { type: "integer", minimum: 1 },
    status: {
      type: "string",
      enum: [
        "pending",
        "processing",
        "on-hold",
        "completed",
        "cancelled",
        "refunded",
        "failed",
      ],
    },
  },
  required: ["orderId", "status"],
  additionalProperties: false,
};

const STOCK_UPDATE_INPUT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    productId: { type: "integer", minimum: 1 },
    manageStock: { type: "boolean" },
    stockQuantity: { type: "integer", minimum: 0 },
    stockStatus: {
      type: "string",
      enum: ["instock", "outofstock", "onbackorder"],
    },
  },
  required: ["productId"],
  additionalProperties: false,
};

const TOOL_LOCALIZATIONS: Readonly<Record<string, ToolLocalizations>> = {
  "orders.list": {
    en: {
      name: "List WooCommerce orders",
      description: "List WooCommerce orders using controlled collection filters.",
    },
    es: {
      name: "Listar pedidos de WooCommerce",
      description: "Lista pedidos de WooCommerce usando filtros controlados de colección.",
    },
  },
  "orders.get": {
    en: {
      name: "Get WooCommerce order",
      description: "Retrieve one WooCommerce order by its numeric ID.",
    },
    es: {
      name: "Obtener pedido de WooCommerce",
      description: "Obtiene un pedido de WooCommerce por su ID numérico.",
    },
  },
  "orders.update-status": {
    en: {
      name: "Update WooCommerce order status",
      description: "Set one WooCommerce order to an explicitly allowed status.",
    },
    es: {
      name: "Actualizar estado de pedido de WooCommerce",
      description: "Establece un pedido de WooCommerce en un estado permitido explícitamente.",
    },
  },
  "products.list": {
    en: {
      name: "List WooCommerce products",
      description: "List WooCommerce products using controlled catalog and stock filters.",
    },
    es: {
      name: "Listar productos de WooCommerce",
      description: "Lista productos de WooCommerce usando filtros controlados de catálogo y stock.",
    },
  },
  "products.get": {
    en: {
      name: "Get WooCommerce product",
      description: "Retrieve one WooCommerce product, including its stock fields, by numeric ID.",
    },
    es: {
      name: "Obtener producto de WooCommerce",
      description: "Obtiene un producto de WooCommerce, incluidos sus campos de stock, por ID numérico.",
    },
  },
  "products.update-stock": {
    en: {
      name: "Update WooCommerce product stock",
      description: "Update only allowlisted stock fields for one WooCommerce product.",
    },
    es: {
      name: "Actualizar stock de producto de WooCommerce",
      description: "Actualiza únicamente campos de stock permitidos para un producto de WooCommerce.",
    },
  },
};

export function createWooCommerceConnector(
  options: WooCommerceConnectorOptions = {},
  runtime?: GenericRestHttpRuntime,
): ConnectorDefinition {
  const network: GenericRestNetworkPolicy = {
    ...(options.allowPrivateNetwork
      ? { allowPrivateNetwork: true }
      : {}),
    ...(options.allowedOrigins
      ? { allowedOrigins: options.allowedOrigins }
      : {}),
  };

  const generic = createGenericRestConnector(
    {
      name: "WooCommerce",
      version: "1.1.0",
      description:
        "Official Kairoseth WooCommerce connector over the authenticated WC REST API v3.",
      auth: {
        type: "basic",
        requirementId: "woocommerce_api",
        usernameField: "consumer_key",
        passwordField: "consumer_secret",
      },
      operations: operations(),
      network,
      response: {
        maxBytes: options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
        redactKeys: ["consumer_key", "consumer_secret"],
      },
    },
    runtime,
  );

  return {
    ...generic,
    manifest: {
      ...generic.manifest,
      id: "woocommerce",
      name: "WooCommerce",
      version: "1.1.0",
      description:
        "Kairoseth connector for WooCommerce orders, products and stock through WC REST API v3.",
      localizations: {
        en: {
          name: "WooCommerce",
          description:
            "Kairoseth connector for WooCommerce orders, products and stock through WC REST API v3.",
        },
        es: {
          name: "WooCommerce",
          description:
            "Conector Kairoseth para pedidos, productos y stock de WooCommerce mediante WC REST API v3.",
        },
      },
      capabilities: [
        "orders.read",
        "orders.write",
        "products.read",
        "products.write",
        "stock.read",
        "stock.write",
      ],
      credentials: [
        {
          id: "woocommerce_api",
          kind: "basic",
          label: "WooCommerce REST API credentials",
          required: true,
          localizations: {
            en: {
              label: "WooCommerce REST API credentials",
              description: "Consumer key and consumer secret generated in WooCommerce REST API settings.",
            },
            es: {
              label: "Credenciales de WooCommerce REST API",
              description: "Consumer key y consumer secret generados en los ajustes de WooCommerce REST API.",
            },
          },
          fields: [
            {
              id: "consumer_key",
              label: "Consumer key",
              secret: true,
              required: true,
              localizations: {
                en: { label: "Consumer key" },
                es: { label: "Consumer key" },
              },
            },
            {
              id: "consumer_secret",
              label: "Consumer secret",
              secret: true,
              required: true,
              localizations: {
                en: { label: "Consumer secret" },
                es: { label: "Consumer secret" },
              },
            },
          ],
        },
      ],
    },
    tools: generic.tools.map((tool) => localizeAndConstrainTool(tool)),
  };
}

function localizeAndConstrainTool(
  tool: ConnectorToolDefinition,
): ConnectorToolDefinition {
  const localizations = TOOL_LOCALIZATIONS[tool.id];

  if (tool.id === "orders.update-status") {
    return {
      ...tool,
      inputSchema: ORDER_STATUS_INPUT_SCHEMA,
      ...(localizations ? { localizations } : {}),
      execute: async (input, context) =>
        await tool.execute(normalizeOrderStatusInput(input), context),
    };
  }

  if (tool.id === "products.update-stock") {
    return {
      ...tool,
      inputSchema: STOCK_UPDATE_INPUT_SCHEMA,
      ...(localizations ? { localizations } : {}),
      execute: async (input, context) =>
        await tool.execute(normalizeStockUpdateInput(input), context),
    };
  }

  return {
    ...tool,
    ...(localizations ? { localizations } : {}),
  };
}

function operations(): readonly GenericRestOperation[] {
  return [
    {
      id: "orders.list",
      name: "List WooCommerce orders",
      description: "List WooCommerce orders using controlled collection filters.",
      risk: "READ",
      method: "GET",
      pathTemplate: "/wp-json/wc/v3/orders",
      query: {
        page: "page",
        per_page: "perPage",
        search: "search",
        after: "after",
        before: "before",
        status: "status",
        customer: "customerId",
        product: "productId",
      },
      inputSchema: {
        type: "object",
        properties: {
          page: { type: "integer", minimum: 1 },
          perPage: { type: "integer", minimum: 1, maximum: 100 },
          search: { type: "string", maxLength: 200 },
          after: { type: "string", format: "date-time" },
          before: { type: "string", format: "date-time" },
          status: {
            type: "array",
            items: { type: "string", maxLength: 64 },
          },
          customerId: { type: "integer", minimum: 1 },
          productId: { type: "integer", minimum: 1 },
        },
        additionalProperties: false,
      },
      outputSchema: {
        type: "array",
        items: { type: "object", additionalProperties: true },
      },
    },
    {
      id: "orders.get",
      name: "Get WooCommerce order",
      description: "Retrieve one WooCommerce order by its numeric ID.",
      risk: "READ",
      method: "GET",
      pathTemplate: "/wp-json/wc/v3/orders/{orderId}",
      inputSchema: {
        type: "object",
        properties: {
          orderId: { type: "integer", minimum: 1 },
        },
        required: ["orderId"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        additionalProperties: true,
      },
    },
    {
      id: "orders.update-status",
      name: "Update WooCommerce order status",
      description: "Set one WooCommerce order to an explicitly allowed status.",
      risk: "WRITE",
      method: "PUT",
      pathTemplate: "/wp-json/wc/v3/orders/{orderId}",
      body: { source: "field", field: "payload" },
      inputSchema: {
        type: "object",
        properties: {
          orderId: { type: "integer", minimum: 1 },
          payload: { type: "object", additionalProperties: false },
        },
        required: ["orderId", "payload"],
        additionalProperties: false,
      },
      outputSchema: { type: "object", additionalProperties: true },
      behavior: {
        retry: { mode: "never" },
        idempotency: { mode: "intrinsic" },
      },
    },
    {
      id: "products.list",
      name: "List WooCommerce products",
      description: "List WooCommerce products using controlled catalog and stock filters.",
      risk: "READ",
      method: "GET",
      pathTemplate: "/wp-json/wc/v3/products",
      query: {
        page: "page",
        per_page: "perPage",
        search: "search",
        sku: "sku",
        status: "status",
        type: "type",
        stock_status: "stockStatus",
      },
      inputSchema: {
        type: "object",
        properties: {
          page: { type: "integer", minimum: 1 },
          perPage: { type: "integer", minimum: 1, maximum: 100 },
          search: { type: "string", maxLength: 200 },
          sku: { type: "string", maxLength: 200 },
          status: { type: "string", maxLength: 32 },
          type: { type: "string", maxLength: 32 },
          stockStatus: {
            type: "string",
            enum: ["instock", "outofstock", "onbackorder"],
          },
        },
        additionalProperties: false,
      },
      outputSchema: {
        type: "array",
        items: { type: "object", additionalProperties: true },
      },
    },
    {
      id: "products.get",
      name: "Get WooCommerce product",
      description: "Retrieve one WooCommerce product and its stock fields by numeric ID.",
      risk: "READ",
      method: "GET",
      pathTemplate: "/wp-json/wc/v3/products/{productId}",
      inputSchema: {
        type: "object",
        properties: {
          productId: { type: "integer", minimum: 1 },
        },
        required: ["productId"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        additionalProperties: true,
      },
    },
    {
      id: "products.update-stock",
      name: "Update WooCommerce product stock",
      description: "Update only allowlisted stock fields for one WooCommerce product.",
      risk: "WRITE",
      method: "PUT",
      pathTemplate: "/wp-json/wc/v3/products/{productId}",
      body: { source: "field", field: "payload" },
      inputSchema: {
        type: "object",
        properties: {
          productId: { type: "integer", minimum: 1 },
          payload: { type: "object", additionalProperties: false },
        },
        required: ["productId", "payload"],
        additionalProperties: false,
      },
      outputSchema: { type: "object", additionalProperties: true },
      behavior: {
        retry: { mode: "never" },
        idempotency: { mode: "intrinsic" },
      },
    },
  ];
}

function normalizeOrderStatusInput(input: unknown): {
  orderId: number;
  payload: { status: string };
} {
  const record = requireExactObject(input, ["orderId", "status"], "order status update");
  const orderId = requirePositiveInteger(record.orderId, "orderId");
  const status = record.status;

  if (typeof status !== "string" || !ORDER_STATUSES.has(status)) {
    throw new ConnectorError("WooCommerce order status is not allowlisted.");
  }

  return { orderId, payload: { status } };
}

function normalizeStockUpdateInput(input: unknown): {
  productId: number;
  payload: Readonly<Record<string, boolean | number | string>>;
} {
  const record = requireExactObject(
    input,
    ["productId", "manageStock", "stockQuantity", "stockStatus"],
    "product stock update",
  );
  const productId = requirePositiveInteger(record.productId, "productId");
  const payload: Record<string, boolean | number | string> = {};

  if (record.manageStock !== undefined) {
    if (typeof record.manageStock !== "boolean") {
      throw new ConnectorError("WooCommerce manageStock must be boolean.");
    }
    payload.manage_stock = record.manageStock;
  }

  if (record.stockQuantity !== undefined) {
    if (
      !Number.isInteger(record.stockQuantity) ||
      typeof record.stockQuantity !== "number" ||
      record.stockQuantity < 0
    ) {
      throw new ConnectorError(
        "WooCommerce stockQuantity must be a non-negative integer.",
      );
    }
    payload.stock_quantity = record.stockQuantity;
  }

  if (record.stockStatus !== undefined) {
    if (
      typeof record.stockStatus !== "string" ||
      !STOCK_STATUSES.has(record.stockStatus)
    ) {
      throw new ConnectorError("WooCommerce stockStatus is not allowlisted.");
    }
    payload.stock_status = record.stockStatus;
  }

  if (Object.keys(payload).length === 0) {
    throw new ConnectorError(
      "WooCommerce stock update requires at least one stock field.",
    );
  }

  return { productId, payload };
}

function requireExactObject(
  input: unknown,
  allowedKeys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ConnectorError(`WooCommerce ${label} input must be an object.`);
  }

  const record = input as Record<string, unknown>;
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new ConnectorError(
      `WooCommerce ${label} contains unsupported field: ${unknown[0]}.`,
    );
  }
  return record;
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new ConnectorError(`WooCommerce ${field} must be a positive integer.`);
  }
  return value;
}

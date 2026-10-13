import type { ToolLocalizations } from "../../core/contracts.js";
import {
  createGenericRestConnector,
} from "../generic-rest/factory.js";
import type {
  GenericRestHttpRuntime,
  GenericRestNetworkPolicy,
  GenericRestOperation,
} from "../generic-rest/contracts.js";
import type { ConnectorDefinition } from "../sdk/contracts.js";

export interface WooCommerceConnectorOptions {
  /** Allow a private RFC1918/ULA destination only for a controlled local/on-prem runtime. */
  allowPrivateNetwork?: boolean | undefined;
  /** Optional exact origin allowlist, e.g. https://shop.example.com. */
  allowedOrigins?: readonly string[] | undefined;
  /** Maximum response bytes. Defaults to 2 MiB. Generic REST hard cap still applies. */
  maxResponseBytes?: number | undefined;
}

const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1_048_576;

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
      version: "1.0.0",
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
      version: "1.0.0",
      description:
        "Kairoseth connector for WooCommerce orders, products and stock through WC REST API v3.",
      capabilities: [
        "orders.read",
        "products.read",
        "stock.read",
      ],
    },
    tools: generic.tools.map((tool) => ({
      ...tool,
      ...(TOOL_LOCALIZATIONS[tool.id]
        ? { localizations: TOOL_LOCALIZATIONS[tool.id] }
        : {}),
    })),
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
  ];
}

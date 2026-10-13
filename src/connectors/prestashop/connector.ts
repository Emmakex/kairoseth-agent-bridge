import type { ToolLocalizations } from "../../core/contracts.js";
import type {
  GenericRestHttpRuntime,
  GenericRestNetworkPolicy,
} from "../generic-rest/contracts.js";
import {
  buildGenericRestUrl,
  defaultGenericRestHttpRuntime,
  validateGenericRestBaseUrl,
} from "../generic-rest/network.js";
import {
  ConnectorError,
  ConnectorTransientError,
} from "../sdk/errors.js";
import { requireConnectorSecret } from "../sdk/secrets.js";
import type {
  ConnectorDefinition,
  ConnectorHealthResult,
  ConnectorToolDefinition,
  JsonSchema,
} from "../sdk/contracts.js";

export interface PrestaShopConnectorOptions {
  allowHttp?: boolean | undefined;
  allowPrivateNetwork?: boolean | undefined;
  allowedOrigins?: readonly string[] | undefined;
  maxResponseBytes?: number | undefined;
}

const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1_048_576;
const ABSOLUTE_MAX_RESPONSE_BYTES = 10 * 1_048_576;
const WEBSERVICE_REQUIREMENT_ID = "prestashop_webservice";
const WEBSERVICE_KEY_FIELD = "webservice_key";
const SENSITIVE_KEYS = new Set([
  "secure_key",
  "passwd",
  "password",
  "api_key",
  "apikey",
  "token",
  "authorization",
]);

const TOOL_LOCALIZATIONS: Readonly<Record<string, ToolLocalizations>> = {
  "orders.list": {
    en: {
      name: "List PrestaShop orders",
      description: "List PrestaShop orders using controlled Webservice filters.",
    },
    es: {
      name: "Listar pedidos de PrestaShop",
      description: "Lista pedidos de PrestaShop usando filtros controlados del Webservice.",
    },
  },
  "orders.get": {
    en: {
      name: "Get PrestaShop order",
      description: "Retrieve one PrestaShop order by numeric ID.",
    },
    es: {
      name: "Obtener pedido de PrestaShop",
      description: "Obtiene un pedido de PrestaShop por ID numérico.",
    },
  },
  "products.list": {
    en: {
      name: "List PrestaShop products",
      description: "List PrestaShop products using controlled catalog filters.",
    },
    es: {
      name: "Listar productos de PrestaShop",
      description: "Lista productos de PrestaShop usando filtros controlados de catálogo.",
    },
  },
  "products.get": {
    en: {
      name: "Get PrestaShop product",
      description: "Retrieve one PrestaShop product by numeric ID.",
    },
    es: {
      name: "Obtener producto de PrestaShop",
      description: "Obtiene un producto de PrestaShop por ID numérico.",
    },
  },
  "stock.get-by-product": {
    en: {
      name: "Get PrestaShop stock by product",
      description: "Read StockAvailable records for one product and optional combination.",
    },
    es: {
      name: "Obtener stock de PrestaShop por producto",
      description: "Consulta registros StockAvailable para un producto y una combinación opcional.",
    },
  },
};

export function createPrestaShopConnector(
  options: PrestaShopConnectorOptions = {},
  runtime: GenericRestHttpRuntime = defaultGenericRestHttpRuntime,
): ConnectorDefinition {
  const maxResponseBytes = normalizeMaxResponseBytes(options.maxResponseBytes);
  const network: GenericRestNetworkPolicy = {
    ...(options.allowHttp ? { allowHttp: true } : {}),
    ...(options.allowPrivateNetwork ? { allowPrivateNetwork: true } : {}),
    ...(options.allowedOrigins ? { allowedOrigins: options.allowedOrigins } : {}),
  };

  const tools: ConnectorToolDefinition[] = [
    makeTool(
      "orders.list",
      "List PrestaShop orders",
      "List PrestaShop orders using controlled Webservice filters.",
      ordersListSchema(),
      async (input, context) => {
        const normalized = normalizeOrdersListInput(input);
        const query = new URLSearchParams({
          output_format: "JSON",
          display: "full",
          limit: `${normalized.offset},${normalized.limit}`,
        });
        if (normalized.customerId !== undefined) {
          query.set("filter[id_customer]", `[${normalized.customerId}]`);
        }
        if (normalized.currentState !== undefined) {
          query.set("filter[current_state]", `[${normalized.currentState}]`);
        }
        return await executeRead(
          "/api/orders",
          query,
          context.config,
          context.secrets,
          context.signal,
          network,
          runtime,
          maxResponseBytes,
        );
      },
    ),
    makeTool(
      "orders.get",
      "Get PrestaShop order",
      "Retrieve one PrestaShop order by numeric ID.",
      idSchema("orderId"),
      async (input, context) => {
        const record = requireExactObject(input, ["orderId"], "order get");
        const orderId = requirePositiveInteger(record.orderId, "orderId");
        return await executeRead(
          `/api/orders/${orderId}`,
          new URLSearchParams({ output_format: "JSON" }),
          context.config,
          context.secrets,
          context.signal,
          network,
          runtime,
          maxResponseBytes,
        );
      },
    ),
    makeTool(
      "products.list",
      "List PrestaShop products",
      "List PrestaShop products using controlled catalog filters.",
      productsListSchema(),
      async (input, context) => {
        const normalized = normalizeProductsListInput(input);
        const query = new URLSearchParams({
          output_format: "JSON",
          display: "full",
          limit: `${normalized.offset},${normalized.limit}`,
        });
        if (normalized.reference !== undefined) {
          query.set("filter[reference]", `[${normalized.reference}]`);
        }
        if (normalized.active !== undefined) {
          query.set("filter[active]", normalized.active ? "[1]" : "[0]");
        }
        return await executeRead(
          "/api/products",
          query,
          context.config,
          context.secrets,
          context.signal,
          network,
          runtime,
          maxResponseBytes,
        );
      },
    ),
    makeTool(
      "products.get",
      "Get PrestaShop product",
      "Retrieve one PrestaShop product by numeric ID.",
      idSchema("productId"),
      async (input, context) => {
        const record = requireExactObject(input, ["productId"], "product get");
        const productId = requirePositiveInteger(record.productId, "productId");
        return await executeRead(
          `/api/products/${productId}`,
          new URLSearchParams({ output_format: "JSON" }),
          context.config,
          context.secrets,
          context.signal,
          network,
          runtime,
          maxResponseBytes,
        );
      },
    ),
    makeTool(
      "stock.get-by-product",
      "Get PrestaShop stock by product",
      "Read StockAvailable records for one product and optional combination.",
      stockSchema(),
      async (input, context) => {
        const normalized = normalizeStockInput(input);
        const query = new URLSearchParams({
          output_format: "JSON",
          display: "full",
        });
        query.set("filter[id_product]", `[${normalized.productId}]`);
        if (normalized.productAttributeId !== undefined) {
          query.set(
            "filter[id_product_attribute]",
            `[${normalized.productAttributeId}]`,
          );
        }
        return await executeRead(
          "/api/stock_availables",
          query,
          context.config,
          context.secrets,
          context.signal,
          network,
          runtime,
          maxResponseBytes,
        );
      },
    ),
  ];

  return {
    manifest: {
      id: "prestashop",
      name: "PrestaShop",
      version: "1.0.0",
      description:
        "Kairoseth connector for PrestaShop orders, products and StockAvailable through the native Webservice API.",
      localizations: {
        en: {
          name: "PrestaShop",
          description:
            "Kairoseth connector for PrestaShop orders, products and StockAvailable through the native Webservice API.",
        },
        es: {
          name: "PrestaShop",
          description:
            "Conector Kairoseth para pedidos, productos y StockAvailable de PrestaShop mediante el Webservice nativo.",
        },
      },
      capabilities: ["orders.read", "products.read", "stock.read"],
      configSchema: {
        type: "object",
        properties: {
          baseUrl: {
            type: "string",
            format: "uri",
            description:
              "PrestaShop installation base URL; subfolder installations are supported.",
          },
        },
        required: ["baseUrl"],
        additionalProperties: false,
      },
      credentials: [
        {
          id: WEBSERVICE_REQUIREMENT_ID,
          kind: "api_key",
          label: "PrestaShop Webservice key",
          required: true,
          localizations: {
            en: {
              label: "PrestaShop Webservice key",
              description:
                "Access key generated in PrestaShop Advanced Parameters > Webservice.",
            },
            es: {
              label: "Clave del Webservice de PrestaShop",
              description:
                "Clave de acceso generada en Parámetros avanzados > Webservice de PrestaShop.",
            },
          },
          fields: [
            {
              id: WEBSERVICE_KEY_FIELD,
              label: "Webservice key",
              secret: true,
              required: true,
              localizations: {
                en: { label: "Webservice key" },
                es: { label: "Clave del Webservice" },
              },
            },
          ],
        },
      ],
    },
    tools,
    health: async (context): Promise<ConnectorHealthResult> => {
      const checkedAt = new Date().toISOString();
      try {
        await validateGenericRestBaseUrl(context.config.baseUrl, network, runtime);
        return {
          status: "healthy",
          checkedAt,
          message: "PrestaShop base URL passed connector network policy.",
        };
      } catch (error) {
        return {
          status: "unhealthy",
          checkedAt,
          message:
            error instanceof Error
              ? `PrestaShop health check failed: ${sanitizeError(error.message)}`
              : "PrestaShop health check failed.",
        };
      }
    },
  };
}

function makeTool(
  id: string,
  name: string,
  description: string,
  inputSchema: JsonSchema,
  execute: ConnectorToolDefinition["execute"],
): ConnectorToolDefinition {
  return {
    id,
    name,
    description,
    ...(TOOL_LOCALIZATIONS[id]
      ? { localizations: TOOL_LOCALIZATIONS[id] }
      : {}),
    risk: "READ",
    inputSchema,
    outputSchema: { type: "object", additionalProperties: true },
    behavior: {
      retry: { mode: "transient", maxAttempts: 3, baseDelayMs: 250, maxDelayMs: 2_000 },
    },
    execute,
  };
}

async function executeRead(
  path: string,
  query: URLSearchParams,
  config: Readonly<Record<string, unknown>>,
  secrets: { getSecret(requirementId: string, fieldId: string): Promise<string | null> },
  signal: AbortSignal,
  network: GenericRestNetworkPolicy,
  runtime: GenericRestHttpRuntime,
  maxResponseBytes: number,
): Promise<{ status: number; ok: true; body: unknown }> {
  const baseUrl = await validateGenericRestBaseUrl(config.baseUrl, network, runtime);
  const url = buildGenericRestUrl(baseUrl, path);
  for (const [name, value] of query.entries()) {
    url.searchParams.append(name, value);
  }

  const key = await requireConnectorSecret(
    secrets,
    WEBSERVICE_REQUIREMENT_ID,
    WEBSERVICE_KEY_FIELD,
  );
  const headers = new Headers({
    accept: "application/json",
    authorization: `Basic ${Buffer.from(`${key}:`, "utf8").toString("base64")}`,
  });

  let response: Response;
  try {
    response = await runtime.fetch(url.toString(), {
      method: "GET",
      headers,
      redirect: "manual",
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ConnectorTransientError(
      `PrestaShop request failed before receiving a response for ${path}.`,
      { cause: error },
    );
  }

  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined);
    throw new ConnectorError(
      `PrestaShop request returned blocked redirect ${response.status}.`,
    );
  }

  const body = await readBoundedJson(response, maxResponseBytes);
  if (!response.ok) {
    const message = `PrestaShop request returned HTTP ${response.status}.`;
    if (response.status === 408 || response.status === 429 || response.status >= 500) {
      throw new ConnectorTransientError(message);
    }
    throw new ConnectorError(message);
  }

  return { status: response.status, ok: true, body };
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > maxBytes) {
    throw new ConnectorError(`PrestaShop response exceeds ${maxBytes} bytes.`);
  }
  if (!response.body) return null;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("response too large").catch(() => undefined);
        throw new ConnectorError(`PrestaShop response exceeds ${maxBytes} bytes.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  if (!text) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new ConnectorError("PrestaShop response could not be parsed as JSON.", {
      cause: error,
    });
  }
  return redactSensitive(parsed);
}

function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (value !== null && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      output[key] = SENSITIVE_KEYS.has(key.toLowerCase())
        ? "[REDACTED]"
        : redactSensitive(child);
    }
    return output;
  }
  return value;
}

function normalizeOrdersListInput(input: unknown): {
  offset: number;
  limit: number;
  customerId?: number;
  currentState?: number;
} {
  const record = requireExactObject(
    input,
    ["offset", "limit", "customerId", "currentState"],
    "orders list",
  );
  return {
    offset: optionalNonNegativeInteger(record.offset, "offset") ?? 0,
    limit: optionalBoundedLimit(record.limit) ?? 50,
    ...(record.customerId !== undefined
      ? { customerId: requirePositiveInteger(record.customerId, "customerId") }
      : {}),
    ...(record.currentState !== undefined
      ? { currentState: requirePositiveInteger(record.currentState, "currentState") }
      : {}),
  };
}

function normalizeProductsListInput(input: unknown): {
  offset: number;
  limit: number;
  reference?: string;
  active?: boolean;
} {
  const record = requireExactObject(
    input,
    ["offset", "limit", "reference", "active"],
    "products list",
  );
  let reference: string | undefined;
  if (record.reference !== undefined) {
    if (
      typeof record.reference !== "string" ||
      !/^[A-Za-z0-9._-]{1,128}$/.test(record.reference)
    ) {
      throw new ConnectorError("PrestaShop reference filter is invalid.");
    }
    reference = record.reference;
  }
  if (record.active !== undefined && typeof record.active !== "boolean") {
    throw new ConnectorError("PrestaShop active filter must be boolean.");
  }
  return {
    offset: optionalNonNegativeInteger(record.offset, "offset") ?? 0,
    limit: optionalBoundedLimit(record.limit) ?? 50,
    ...(reference !== undefined ? { reference } : {}),
    ...(record.active !== undefined ? { active: record.active } : {}),
  };
}

function normalizeStockInput(input: unknown): {
  productId: number;
  productAttributeId?: number;
} {
  const record = requireExactObject(
    input,
    ["productId", "productAttributeId"],
    "stock get",
  );
  return {
    productId: requirePositiveInteger(record.productId, "productId"),
    ...(record.productAttributeId !== undefined
      ? {
          productAttributeId: requireNonNegativeInteger(
            record.productAttributeId,
            "productAttributeId",
          ),
        }
      : {}),
  };
}

function ordersListSchema(): JsonSchema {
  return {
    type: "object",
    properties: {
      offset: { type: "integer", minimum: 0 },
      limit: { type: "integer", minimum: 1, maximum: 100 },
      customerId: { type: "integer", minimum: 1 },
      currentState: { type: "integer", minimum: 1 },
    },
    additionalProperties: false,
  };
}

function productsListSchema(): JsonSchema {
  return {
    type: "object",
    properties: {
      offset: { type: "integer", minimum: 0 },
      limit: { type: "integer", minimum: 1, maximum: 100 },
      reference: { type: "string", maxLength: 128 },
      active: { type: "boolean" },
    },
    additionalProperties: false,
  };
}

function stockSchema(): JsonSchema {
  return {
    type: "object",
    properties: {
      productId: { type: "integer", minimum: 1 },
      productAttributeId: { type: "integer", minimum: 0 },
    },
    required: ["productId"],
    additionalProperties: false,
  };
}

function idSchema(field: string): JsonSchema {
  return {
    type: "object",
    properties: { [field]: { type: "integer", minimum: 1 } },
    required: [field],
    additionalProperties: false,
  };
}

function requireExactObject(
  input: unknown,
  allowedKeys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ConnectorError(`PrestaShop ${label} input must be an object.`);
  }
  const record = input as Record<string, unknown>;
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(record).find((key) => !allowed.has(key));
  if (unknown) {
    throw new ConnectorError(`PrestaShop ${label} contains unsupported field: ${unknown}.`);
  }
  return record;
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new ConnectorError(`PrestaShop ${field} must be a positive integer.`);
  }
  return value;
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ConnectorError(`PrestaShop ${field} must be a non-negative integer.`);
  }
  return value;
}

function optionalNonNegativeInteger(value: unknown, field: string): number | undefined {
  return value === undefined ? undefined : requireNonNegativeInteger(value, field);
}

function optionalBoundedLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const limit = requirePositiveInteger(value, "limit");
  if (limit > 100) throw new ConnectorError("PrestaShop limit cannot exceed 100.");
  return limit;
}

function normalizeMaxResponseBytes(value: number | undefined): number {
  const max = value ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (!Number.isInteger(max) || max < 1 || max > ABSOLUTE_MAX_RESPONSE_BYTES) {
    throw new Error(
      `PrestaShop maxResponseBytes must be between 1 and ${ABSOLUTE_MAX_RESPONSE_BYTES}.`,
    );
  }
  return max;
}

function sanitizeError(message: string): string {
  return message.replace(/[\r\n\t]/g, " ").slice(0, 256);
}

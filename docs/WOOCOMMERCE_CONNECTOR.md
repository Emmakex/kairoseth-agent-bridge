# WooCommerce Connector / Conector WooCommerce

## ES

El conector oficial de WooCommerce expone una superficie controlada de WooCommerce REST API v3 como tools normalizadas de Kairoseth Agent Bridge.

### Primera microfase — READ

Tools disponibles:

- `orders.list` — listar pedidos con filtros controlados;
- `orders.get` — obtener un pedido por ID;
- `products.list` — listar productos con filtros de catálogo/stock;
- `products.get` — obtener un producto por ID, incluidos sus campos de stock devueltos por WooCommerce.

Los IDs en runtime quedan namespaced por instalación:

```text
woocommerce.<instanceId>.orders.list
woocommerce.<instanceId>.orders.get
woocommerce.<instanceId>.products.list
woocommerce.<instanceId>.products.get
```

### Configuración

La instancia declara únicamente configuración no secreta:

```json
{
  "baseUrl": "https://tienda.example.com"
}
```

El conector construye las rutas bajo:

```text
/wp-json/wc/v3/
```

HTTPS es obligatorio por defecto. Una red privada solo puede habilitarse explícitamente para un runtime local/on-prem controlado.

### Credenciales

Se utilizan claves REST API de WooCommerce:

- `consumer_key`;
- `consumer_secret`.

Los valores nunca viven en el manifest ni en la configuración del conector. Se resuelven en ejecución mediante `ConnectorSecretProvider` y se envían como HTTP Basic Auth sobre HTTPS.

La metadata de setup y todas las tools oficiales publican textos ES/EN.

### Seguridad heredada

El conector reutiliza Generic REST y por tanto conserva:

- protección SSRF / bloqueo de destinos privados por defecto;
- allowlist opcional de origin;
- bloqueo de redirects;
- límites de tamaño de respuesta;
- redacción de claves sensibles;
- timeout/retry del Connector SDK;
- policy READ / WRITE / CRITICAL del Bridge;
- auditoría y approvals del core.

Esta primera microfase es solo READ. No expone cambio de estado de pedido ni modificación de producto/stock.

### Siguiente microfase

Se añadirán operaciones WRITE controladas:

- actualizar estado/metadatos permitidos de pedido;
- actualizar stock/campos permitidos de producto.

Toda mutación pasará por el policy gate y approvals. El retry automático solo podrá existir cuando la operación tenga una estrategia de idempotencia segura.

---

## EN

The official WooCommerce connector exposes a controlled WooCommerce REST API v3 surface as normalized Kairoseth Agent Bridge tools.

### First microphase — READ

Available tools:

- `orders.list` — list orders with controlled filters;
- `orders.get` — retrieve one order by ID;
- `products.list` — list products with catalog/stock filters;
- `products.get` — retrieve one product by ID, including stock fields returned by WooCommerce.

Runtime IDs are namespaced per connector instance:

```text
woocommerce.<instanceId>.orders.list
woocommerce.<instanceId>.orders.get
woocommerce.<instanceId>.products.list
woocommerce.<instanceId>.products.get
```

### Configuration

The instance declares non-secret configuration only:

```json
{
  "baseUrl": "https://shop.example.com"
}
```

The connector builds endpoints under:

```text
/wp-json/wc/v3/
```

HTTPS is required by default. Private-network access can only be enabled explicitly for a controlled local/on-prem runtime.

### Credentials

WooCommerce REST API keys are used:

- `consumer_key`;
- `consumer_secret`.

Values never live in the manifest or connector configuration. They are resolved at runtime through `ConnectorSecretProvider` and sent as HTTP Basic Auth over HTTPS.

Setup metadata and all official tools publish ES/EN text.

### Inherited security

The connector reuses Generic REST and therefore preserves:

- SSRF protection / private destinations blocked by default;
- optional exact-origin allowlist;
- redirect blocking;
- response-size bounds;
- sensitive-key redaction;
- Connector SDK timeout/retry behavior;
- Bridge READ / WRITE / CRITICAL policy;
- core audit and approval flows.

This first microphase is READ-only. It does not expose order-status changes or product/stock mutations.

### Next microphase

Controlled WRITE operations will add:

- allowed order status/metadata updates;
- allowed product/stock updates.

Every mutation will pass through the policy gate and approvals. Automatic retries will only be enabled when the operation has a safe idempotency strategy.

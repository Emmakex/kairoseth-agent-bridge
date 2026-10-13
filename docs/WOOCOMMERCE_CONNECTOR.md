# WooCommerce Connector / Conector WooCommerce

## ES

El conector oficial de WooCommerce expone una superficie controlada de WooCommerce REST API v3 como tools normalizadas de Kairoseth Agent Bridge.

### Superficie inicial

Tools READ:

- `orders.list` — listar pedidos con filtros controlados;
- `orders.get` — obtener un pedido por ID;
- `products.list` — listar productos con filtros de catálogo/stock;
- `products.get` — obtener un producto por ID, incluidos sus campos de stock devueltos por WooCommerce.

Tools WRITE:

- `orders.update-status` — cambiar únicamente el estado de un pedido a un valor permitido;
- `products.update-stock` — modificar únicamente campos de stock permitidos de un producto.

Los IDs en runtime quedan namespaced por instancia:

```text
woocommerce.<instanceId>.orders.list
woocommerce.<instanceId>.orders.get
woocommerce.<instanceId>.orders.update-status
woocommerce.<instanceId>.products.list
woocommerce.<instanceId>.products.get
woocommerce.<instanceId>.products.update-stock
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

La metadata de setup, manifest y todas las tools oficiales publican textos ES/EN.

### Mutaciones allowlisted

`orders.update-status` acepta exclusivamente:

```json
{
  "orderId": 42,
  "status": "completed"
}
```

Estados permitidos:

```text
pending
processing
on-hold
completed
cancelled
refunded
failed
```

`trash` no se expone como operación del Bridge.

`products.update-stock` acepta exclusivamente:

```json
{
  "productId": 77,
  "manageStock": true,
  "stockQuantity": 8,
  "stockStatus": "instock"
}
```

Los únicos campos remotos que se pueden construir son:

```text
manage_stock
stock_quantity
stock_status
```

No se permite introducir un body WooCommerce arbitrario ni modificar por esta tool precio, título, descripción u otros campos del producto. La cantidad de stock debe ser un entero no negativo y el update debe incluir al menos un campo de stock.

### Policy, approvals e idempotencia

Ambas mutaciones son `WRITE`. Con la policy segura por defecto:

```text
MCP / agente / Kairoseth
        ↓
WooCommerce WRITE tool
        ↓
BridgeRuntime.invoke()
        ↓
REQUIRE_APPROVAL
        ↓
0 peticiones HTTP hasta tener autorización válida
```

Los bodies que llegan a WooCommerce se generan internamente después del policy gate. Los campos adicionales se rechazan antes de ejecutar HTTP.

Las dos operaciones declaran idempotencia intrínseca porque expresan un estado objetivo, pero usan `retry: never`: Agent Bridge no reenvía automáticamente una mutación WooCommerce ante un fallo incierto.

### Seguridad heredada

El conector reutiliza Generic REST y por tanto conserva:

- protección SSRF / bloqueo de destinos privados por defecto;
- allowlist opcional de origin;
- bloqueo de redirects;
- límites de tamaño de respuesta;
- redacción de claves sensibles;
- timeout/retry del Connector SDK;
- policy READ / WRITE / CRITICAL del Bridge;
- signed approvals y replay protection del core;
- auditoría saneada.

---

## EN

The official WooCommerce connector exposes a controlled WooCommerce REST API v3 surface as normalized Kairoseth Agent Bridge tools.

### Initial surface

READ tools:

- `orders.list` — list orders with controlled filters;
- `orders.get` — retrieve one order by ID;
- `products.list` — list products with catalog/stock filters;
- `products.get` — retrieve one product by ID, including stock fields returned by WooCommerce.

WRITE tools:

- `orders.update-status` — change only an order status to an explicitly allowed value;
- `products.update-stock` — change only allowlisted stock fields for one product.

Runtime IDs are namespaced per connector instance:

```text
woocommerce.<instanceId>.orders.list
woocommerce.<instanceId>.orders.get
woocommerce.<instanceId>.orders.update-status
woocommerce.<instanceId>.products.list
woocommerce.<instanceId>.products.get
woocommerce.<instanceId>.products.update-stock
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

Setup metadata, manifest text, and all official tools publish ES/EN text.

### Allowlisted mutations

`orders.update-status` accepts only:

```json
{
  "orderId": 42,
  "status": "completed"
}
```

Allowed statuses:

```text
pending
processing
on-hold
completed
cancelled
refunded
failed
```

`trash` is intentionally not exposed as a Bridge operation.

`products.update-stock` accepts only:

```json
{
  "productId": 77,
  "manageStock": true,
  "stockQuantity": 8,
  "stockStatus": "instock"
}
```

The only remote fields the connector can construct are:

```text
manage_stock
stock_quantity
stock_status
```

The agent cannot submit an arbitrary WooCommerce body or use this tool to change price, title, description, or unrelated product fields. Stock quantity must be a non-negative integer and the update must contain at least one stock field.

### Policy, approvals, and idempotency

Both mutations are `WRITE`. Under the secure default policy:

```text
MCP / agent / Kairoseth
        ↓
WooCommerce WRITE tool
        ↓
BridgeRuntime.invoke()
        ↓
REQUIRE_APPROVAL
        ↓
0 HTTP requests until valid authorization exists
```

Bodies sent to WooCommerce are generated internally after the policy gate. Additional public input fields are rejected before HTTP execution.

Both operations declare intrinsic idempotency because they express a desired state, but use `retry: never`: Agent Bridge does not automatically resend a WooCommerce mutation after an uncertain failure.

### Inherited security

The connector reuses Generic REST and therefore preserves:

- SSRF protection / private destinations blocked by default;
- optional exact-origin allowlist;
- redirect blocking;
- response-size bounds;
- sensitive-key redaction;
- Connector SDK timeout/retry behavior;
- Bridge READ / WRITE / CRITICAL policy;
- signed approvals and replay protection;
- sanitized audit.

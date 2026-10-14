# PrestaShop Connector / Conector PrestaShop

## ES

El conector oficial de PrestaShop expone una superficie controlada del Webservice nativo como tools normalizadas de Kairoseth Agent Bridge.

### Superficie inicial

Tools READ:

- `orders.list` — listar pedidos con filtros controlados;
- `orders.get` — obtener un pedido por ID;
- `order-states.list` — listar los estados de pedido configurados realmente en la tienda;
- `products.list` — listar productos con filtros controlados;
- `products.get` — obtener un producto por ID;
- `stock.get-by-product` — consultar `StockAvailable` para un producto y una combinación opcional.

Tools WRITE:

- `orders.update-status` — cambiar el estado creando un `OrderHistory`, en lugar de modificar `orders.current_state` directamente;
- `stock.update-quantity` — fijar la cantidad absoluta de un `StockAvailable` mediante PATCH parcial.

Los IDs en runtime quedan namespaced por instancia:

```text
prestashop.<instanceId>.orders.list
prestashop.<instanceId>.orders.get
prestashop.<instanceId>.order-states.list
prestashop.<instanceId>.orders.update-status
prestashop.<instanceId>.products.list
prestashop.<instanceId>.products.get
prestashop.<instanceId>.stock.get-by-product
prestashop.<instanceId>.stock.update-quantity
```

### Endpoint y subcarpetas

La configuración no secreta contiene únicamente la URL base de la instalación:

```json
{
  "baseUrl": "https://tienda.example.com/prestashop"
}
```

El conector conserva el prefijo de instalación y construye el Webservice bajo `/api/`.

HTTPS es obligatorio por defecto. HTTP y redes privadas solo pueden habilitarse explícitamente para despliegues locales/on-prem controlados.

### Credenciales

PrestaShop usa una clave de Webservice como usuario de HTTP Basic Auth y contraseña vacía.

La clave:

- se declara como `webservice_key`;
- se resuelve exclusivamente mediante `ConnectorSecretProvider`;
- nunca se coloca en la URL;
- nunca se almacena en manifest/configuración;
- nunca se devuelve en resultados o auditoría.

### READ, JSON y filtros

Las peticiones READ solicitan `output_format=JSON`. Las listas usan únicamente filtros declarados por el conector y paginación limitada; no se expone una interfaz libre de query parameters.

El stock se consulta mediante `stock_availables`. `order-states.list` permite descubrir los IDs de estado configurados por cada tienda en vez de asumir valores globales.

### WRITE de estado de pedido

`orders.update-status` recibe únicamente:

- `orderId`;
- `orderStateId`;
- `sendEmail` opcional, `false` por defecto.

La mutación crea un recurso `order_histories` con XML generado internamente y solo los campos `id_order` e `id_order_state`. Así se utiliza el flujo de cambio de estado del Webservice de PrestaShop en lugar de escribir directamente el campo `current_state` del pedido.

La operación se considera **no idempotente**: repetirla podría crear otra entrada de historial y volver a ejecutar efectos asociados. Por ello declara `retry: never`.

### WRITE de stock

`stock.update-quantity` recibe:

- `stockAvailableId`;
- `productId`;
- `productAttributeId` opcional, `0` por defecto;
- `quantity` absoluta.

Antes del PATCH, el conector lee `/api/stock_availables/<id>` y comprueba que el registro pertenece exactamente al producto/combinación esperados. Solo después envía un PATCH XML generado internamente con `id` y `quantity`.

Fijar una cantidad absoluta se marca como idempotencia intrínseca, pero sigue declarando `retry: never`: un resultado de red incierto nunca provoca una segunda mutación automática.

### Approvals y seguridad

Con la policy segura por defecto, ambas WRITE devuelven `approval_required` antes de realizar cualquier llamada HTTP. Tras una aprobación válida, la ejecución continúa por el mismo `BridgeRuntime`, auditoría y controles del core.

El conector conserva además:

- policy READ / WRITE / CRITICAL;
- SecretProvider para credenciales;
- HTTPS/public-network por defecto;
- protección SSRF y allowlist opcional de origin;
- redirects bloqueados;
- límites de tamaño de respuesta;
- redacción recursiva de `secure_key`, password/token/api-key y claves sensibles;
- validación estricta de input y rechazo de campos adicionales;
- retry únicamente para fallos transitorios de READ;
- ninguna repetición automática de WRITE;
- metadata ES/EN en manifest, setup y todas las tools.

No se expone SQL, paths arbitrarios, XML arbitrario ni un cliente Webservice genérico. Futuras capacidades deben añadirse como tools independientes y allowlisted.

---

## EN

The official PrestaShop connector exposes a controlled native Webservice surface as normalized Kairoseth Agent Bridge tools.

### Initial surface

READ tools:

- `orders.list` — list orders with controlled filters;
- `orders.get` — retrieve one order by ID;
- `order-states.list` — list the order states actually configured by the shop;
- `products.list` — list products with controlled filters;
- `products.get` — retrieve one product by ID;
- `stock.get-by-product` — query `StockAvailable` for a product and optional combination.

WRITE tools:

- `orders.update-status` — change state by creating an `OrderHistory` instead of directly editing `orders.current_state`;
- `stock.update-quantity` — set an absolute `StockAvailable` quantity through partial PATCH.

Runtime IDs are namespaced per instance:

```text
prestashop.<instanceId>.orders.list
prestashop.<instanceId>.orders.get
prestashop.<instanceId>.order-states.list
prestashop.<instanceId>.orders.update-status
prestashop.<instanceId>.products.list
prestashop.<instanceId>.products.get
prestashop.<instanceId>.stock.get-by-product
prestashop.<instanceId>.stock.update-quantity
```

### Endpoint and subfolders

Non-secret configuration contains only the installation base URL:

```json
{
  "baseUrl": "https://shop.example.com/prestashop"
}
```

The connector preserves the installation prefix and builds the Webservice under `/api/`.

HTTPS is required by default. HTTP and private-network access can only be enabled explicitly for controlled local/on-prem deployments.

### Credentials

PrestaShop uses the Webservice access key as the HTTP Basic Auth username with an empty password.

The key:

- is declared as `webservice_key`;
- is resolved exclusively through `ConnectorSecretProvider`;
- is never placed in the URL;
- is never stored in manifest/configuration;
- is never returned in results or audit.

### READ, JSON and filters

READ requests use `output_format=JSON`. Collection tools expose only connector-declared filters and bounded pagination; arbitrary query parameters are not exposed.

Stock is queried through `stock_availables`. `order-states.list` lets agents discover the state IDs configured by each shop rather than assuming global values.

### Order-status WRITE

`orders.update-status` accepts only:

- `orderId`;
- `orderStateId`;
- optional `sendEmail`, defaulting to `false`.

The mutation creates an `order_histories` resource using connector-generated XML containing only `id_order` and `id_order_state`. This uses PrestaShop's Webservice state-transition flow instead of directly writing the order's `current_state` field.

The operation is considered **non-idempotent**: repeating it could create another history entry and repeat associated effects. It therefore declares `retry: never`.

### Stock WRITE

`stock.update-quantity` accepts:

- `stockAvailableId`;
- `productId`;
- optional `productAttributeId`, defaulting to `0`;
- absolute `quantity`.

Before PATCH, the connector reads `/api/stock_availables/<id>` and verifies that the record belongs exactly to the expected product/combination. Only then does it send connector-generated PATCH XML containing `id` and `quantity`.

Setting an absolute quantity is marked intrinsically idempotent, but it still declares `retry: never`: an uncertain network outcome never triggers a second automatic mutation.

### Approvals and security

Under the secure-default policy, both WRITE tools return `approval_required` before any HTTP call. After a valid approval, execution still flows through the same `BridgeRuntime`, audit and core controls.

The connector also preserves:

- Bridge READ / WRITE / CRITICAL policy;
- SecretProvider credentials;
- HTTPS/public-network defaults;
- SSRF protection and optional exact-origin allowlist;
- redirect blocking;
- bounded response sizes;
- recursive redaction of `secure_key`, password/token/api-key and sensitive keys;
- strict input validation and additional-field rejection;
- retries only for transient READ failures;
- no automatic WRITE retries;
- ES/EN metadata for manifest, setup and every tool.

No SQL, arbitrary paths, arbitrary XML or generic Webservice client are exposed. Future capabilities must be added as separate allowlisted tools.

# PrestaShop Connector / Conector PrestaShop

## ES

El conector oficial de PrestaShop expone una superficie controlada del Webservice nativo como tools normalizadas de Kairoseth Agent Bridge.

### Baseline READ

Tools iniciales:

- `orders.list` — listar pedidos con filtros controlados;
- `orders.get` — obtener un pedido por ID;
- `products.list` — listar productos con filtros controlados;
- `products.get` — obtener un producto por ID;
- `stock.get-by-product` — consultar `StockAvailable` para un producto y una combinación opcional.

Los IDs en runtime quedan namespaced por instancia:

```text
prestashop.<instanceId>.orders.list
prestashop.<instanceId>.orders.get
prestashop.<instanceId>.products.list
prestashop.<instanceId>.products.get
prestashop.<instanceId>.stock.get-by-product
```

### Endpoint y subcarpetas

La configuración no secreta contiene únicamente la URL base de la instalación:

```json
{
  "baseUrl": "https://tienda.example.com/prestashop"
}
```

El conector conserva el prefijo de instalación y construye el Webservice bajo `/api/`. Por ejemplo:

```text
https://tienda.example.com/prestashop/api/orders
```

HTTPS es obligatorio por defecto. HTTP y redes privadas solo pueden habilitarse explícitamente para despliegues locales/on-prem controlados.

### Credenciales

PrestaShop usa una clave de Webservice como usuario de HTTP Basic Auth y contraseña vacía.

La clave:

- se declara como `webservice_key`;
- se resuelve exclusivamente mediante `ConnectorSecretProvider`;
- nunca se coloca en la URL;
- nunca se almacena en manifest/configuración;
- nunca se devuelve en resultados o auditoría.

### JSON y filtros

Las peticiones READ solicitan `output_format=JSON`. Las listas usan únicamente filtros declarados por el conector y paginación limitada; no se expone una interfaz libre de query parameters.

El stock se consulta mediante el recurso `stock_availables`, que es la fuente autoritativa de cantidad para productos y combinaciones.

### Seguridad

El baseline conserva:

- policy READ / WRITE / CRITICAL del Bridge;
- SecretProvider para credenciales;
- HTTPS/public-network por defecto;
- protección SSRF y allowlist opcional de origin;
- redirects bloqueados;
- límites de tamaño de respuesta;
- redacción recursiva de `secure_key`, password/token/api-key y claves sensibles;
- validación estricta de input y rechazo de campos adicionales;
- retry únicamente para fallos transitorios de operaciones READ;
- auditoría del core;
- metadata ES/EN en manifest, setup y tools.

No se expone SQL, paths arbitrarios ni un cliente Webservice genérico.

### Próxima microfase

Las mutaciones se implementarán como tools independientes y allowlisted. No existirá un endpoint genérico para modificar cualquier recurso de PrestaShop.

Los primeros WRITE previstos son actualización controlada de estado de pedido y actualización controlada de `StockAvailable`, siempre detrás del policy/approval gate y sin retry automático inseguro.

---

## EN

The official PrestaShop connector exposes a controlled native Webservice surface as normalized Kairoseth Agent Bridge tools.

### READ baseline

Initial tools:

- `orders.list` — list orders with controlled filters;
- `orders.get` — retrieve one order by ID;
- `products.list` — list products with controlled filters;
- `products.get` — retrieve one product by ID;
- `stock.get-by-product` — query `StockAvailable` for a product and optional combination.

Runtime IDs are namespaced per instance:

```text
prestashop.<instanceId>.orders.list
prestashop.<instanceId>.orders.get
prestashop.<instanceId>.products.list
prestashop.<instanceId>.products.get
prestashop.<instanceId>.stock.get-by-product
```

### Endpoint and subfolders

Non-secret configuration contains only the installation base URL:

```json
{
  "baseUrl": "https://shop.example.com/prestashop"
}
```

The connector preserves the installation prefix and builds the Webservice under `/api/`. Example:

```text
https://shop.example.com/prestashop/api/orders
```

HTTPS is required by default. HTTP and private-network access can only be enabled explicitly for controlled local/on-prem deployments.

### Credentials

PrestaShop uses the Webservice access key as the HTTP Basic Auth username with an empty password.

The key:

- is declared as `webservice_key`;
- is resolved exclusively through `ConnectorSecretProvider`;
- is never placed in the URL;
- is never stored in manifest/configuration;
- is never returned in results or audit.

### JSON and filters

READ requests use `output_format=JSON`. Collection tools expose only connector-declared filters and bounded pagination; arbitrary query parameters are not exposed.

Stock is queried through the `stock_availables` resource, the authoritative quantity source for products and combinations.

### Security

The baseline preserves:

- Bridge READ / WRITE / CRITICAL policy;
- SecretProvider credentials;
- HTTPS/public-network defaults;
- SSRF protection and optional exact-origin allowlist;
- redirect blocking;
- bounded response sizes;
- recursive redaction of `secure_key`, password/token/api-key and sensitive keys;
- strict input validation and additional-field rejection;
- retries only for transient READ failures;
- core audit;
- ES/EN metadata for manifest, setup and tools.

No SQL, arbitrary paths or generic Webservice client are exposed.

### Next microphase

Mutations will be implemented as separate allowlisted tools. There will be no generic endpoint for modifying arbitrary PrestaShop resources.

The first planned WRITE tools are a controlled order-status update and a controlled `StockAvailable` update, always behind the policy/approval gate and without unsafe automatic mutation retries.

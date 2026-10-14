# Kairoseth Agent Bridge — Connector Inventory

## ES

### Objetivo

Agent Bridge necesita informar a Kairoseth Platform qué conectores e instancias están realmente configurados en un runtime, sin convertir ese inventario en una fuente de permisos y sin exponer configuración privada ni credenciales.

`buildConnectorInventory()` genera un snapshot determinista y exclusivamente descriptivo.

### El snapshot incluye

Por instancia de conector:

- `connectorId`
- `connectorInstanceId`
- nombre, versión y descripción
- localizaciones ES/EN cuando existen
- capabilities declaradas
- tools declaradas

Por tool:

- `toolId`
- `runtimeToolId` namespaced
- nombre y descripción
- localizaciones ES/EN cuando existen
- riesgo `READ`, `WRITE` o `CRITICAL`

### El snapshot excluye deliberadamente

- `instance.config`
- URLs privadas, rutas locales u otros detalles de configuración
- requisitos de credenciales
- valores de credenciales
- referencias a `SecretProvider`
- input/output schemas
- inputs y resultados de ejecución

El inventario nunca concede permiso de ejecución. La autoridad continúa en ToolRegistry, BridgeRuntime, policy, approvals y audit.

### Orden determinista

Las instancias se ordenan por `connectorId` + `connectorInstanceId`; las tools por `toolId`; las capabilities se deduplican y ordenan. Esto permite comparar snapshots y evitar cambios falsos por orden de registro.

## EN

### Goal

Agent Bridge needs to report which connector instances are actually configured in a runtime without turning inventory into an authorization source and without exposing private configuration or credentials.

`buildConnectorInventory()` creates a deterministic, descriptive-only snapshot.

### The snapshot includes

Per connector instance:

- `connectorId`
- `connectorInstanceId`
- name, version, and description
- ES/EN localizations when available
- declared capabilities
- declared tools

Per tool:

- `toolId`
- namespaced `runtimeToolId`
- name and description
- ES/EN localizations when available
- `READ`, `WRITE`, or `CRITICAL` risk

### The snapshot deliberately excludes

- `instance.config`
- private URLs, local paths, and other configuration details
- credential requirements
- credential values
- `SecretProvider` references
- input/output schemas
- execution inputs and results

Inventory never grants execution permission. Authority remains in ToolRegistry, BridgeRuntime, policy, approvals, and audit.

### Deterministic ordering

Instances are sorted by `connectorId` + `connectorInstanceId`; tools by `toolId`; capabilities are deduplicated and sorted. This makes snapshots comparable without false changes caused by registration order.

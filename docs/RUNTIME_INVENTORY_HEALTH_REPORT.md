# Kairoseth Agent Bridge — Runtime Inventory + Health Report

## ES

### Objetivo

Una vez abierta la sesión autenticada, el runtime puede reportar a Kairoseth Platform qué conectores/tools están realmente registrados y cuál es su estado operativo actual.

Este reporte es observabilidad. No concede permisos, no cambia policy y no sustituye aprobaciones ni auditoría de ejecución.

### Contrato

`RuntimeSnapshotReporter` construye `kab.runtime-snapshot.v1` con:

- `snapshotId` único
- `generatedAt`
- inventario seguro de conectores/instancias/tools
- health reducido por conector e instancia
- disponibilidad por tool

Cada snapshot se envía con el access token de la sesión corta mediante `Authorization: Bearer`.

### Reducción de health

El reporte conserva únicamente:

- `connectorId`
- `connectorInstanceId`
- `status`: `healthy`, `degraded`, `unhealthy`
- `checkedAt`
- por tool: ID, runtime ID, `available/degraded/blocked` y motivo bloqueado cuando aplica

Se excluyen deliberadamente `probe.message`, `probe.details` y el estado interno completo del circuit breaker/rotación. Esto evita transportar texto arbitrario del backend hacia el control plane.

### Inventario seguro

El inventario reutiliza `buildConnectorInventory()` y excluye:

- configuración de instancia
- URLs privadas o paths locales
- requisitos/valores de credenciales
- referencias a SecretProvider
- schemas de entrada/salida
- inputs y outputs de ejecución

El reporter exige que las instancias usadas para construir el inventario coincidan exactamente con las registradas en `ConnectorRegistryAdapter`; si no coinciden, falla cerrado antes de enviar.

### Transporte HTTP

`HttpRuntimeSnapshotTransport`:

- usa HTTPS fuera de localhost
- bloquea redirects
- usa `no-store`
- nunca coloca el token en URL/query/body
- expone errores acotados por HTTP status + code
- no propaga bodies de error ni secretos

Endpoint esperado:

`POST /api/products/agent-bridge/runtime-snapshot`

## EN

### Goal

Once the authenticated session is open, the runtime can report to Kairoseth Platform which connectors/tools are actually registered and their current operational health.

This report is observability only. It does not grant permissions, change policy, or replace approvals or execution audit.

### Contract

`RuntimeSnapshotReporter` builds `kab.runtime-snapshot.v1` with:

- unique `snapshotId`
- `generatedAt`
- safe connector/instance/tool inventory
- reduced connector-instance health
- per-tool availability

Each snapshot is sent with the short-lived session access token in `Authorization: Bearer`.

### Health reduction

The report keeps only:

- `connectorId`
- `connectorInstanceId`
- `healthy`, `degraded`, or `unhealthy` status
- `checkedAt`
- per tool: ID, runtime ID, `available/degraded/blocked`, plus blocked reason when applicable

`probe.message`, `probe.details`, and full internal circuit-breaker/rotation state are deliberately excluded. This prevents arbitrary backend text from flowing into the control plane.

### Safe inventory

Inventory reuses `buildConnectorInventory()` and excludes:

- instance configuration
- private URLs or local paths
- credential requirements/values
- SecretProvider references
- input/output schemas
- execution inputs and outputs

The reporter requires the inventory instance set to exactly match the instances registered in `ConnectorRegistryAdapter`; a mismatch fails closed before transport.

### HTTP transport

`HttpRuntimeSnapshotTransport`:

- requires HTTPS outside localhost
- blocks redirects
- uses `no-store`
- never places the token in URL/query/body
- exposes bounded HTTP status + code errors
- never propagates raw error bodies or secrets

Expected endpoint:

`POST /api/products/agent-bridge/runtime-snapshot`

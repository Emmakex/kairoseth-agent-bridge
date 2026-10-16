# Platform A2A task storage / Almacenamiento A2A compartido en Platform

## ES — Backend autoritativo para despliegues clustered

`PlatformA2ATaskStore` es el cliente de almacenamiento A2A compartido para runtimes de Kairoseth Agent Bridge que pueden ejecutarse en más de un nodo.

La autoridad sigue siendo **Kairoseth Platform**. Agent Bridge no crea una segunda base de datos de tenants ni obliga al cliente a instalar Redis, MongoDB o PostgreSQL para coordinar tareas A2A.

### Principios

- la comunicación es outbound desde Agent Bridge hacia Platform;
- se reutiliza el token de sesión autenticada del Bridge mediante un `accessToken` provider;
- el token se obtiene de nuevo en cada operación para admitir renovación de sesión;
- no existe fallback automático a memoria o disco local si Platform no está disponible;
- `save`, `get`, `claimTransition` y `completeTransition` usan `POST`, `Cache-Control: no-store` y redirecciones bloqueadas;
- HTTPS es obligatorio fuera de desarrollo local;
- errores de transporte, respuestas inválidas y bindings inconsistentes fallan de forma cerrada;
- el cliente no reintenta automáticamente operaciones de transición.

### Endpoints v1

Por defecto:

```text
POST /api/products/agent-bridge/a2a/tasks/save
POST /api/products/agent-bridge/a2a/tasks/get
POST /api/products/agent-bridge/a2a/tasks/claim
POST /api/products/agent-bridge/a2a/tasks/complete
```

Todos requieren `Authorization: Bearer <bridge-session-token>`.

#### Save

Request:

```json
{
  "version": "kab.a2a-task-save.v1",
  "record": {}
}
```

Platform debe crear o actualizar la tarea dentro del scope autenticado. Debe rechazar colisiones de `taskId` entre scopes y escrituras ordinarias mientras exista un claim activo.

#### Get

Request:

```json
{
  "version": "kab.a2a-task-get.v1",
  "taskId": "task-id",
  "scope": {
    "actor": "agent:finance",
    "tenantId": "tenant-id",
    "installationId": "installation-id"
  }
}
```

Response:

```json
{ "record": null }
```

o:

```json
{ "record": {} }
```

El record devuelto debe coincidir exactamente con `taskId` y scope solicitados.

#### Claim

Request:

```json
{
  "version": "kab.a2a-task-claim.v1",
  "taskId": "task-id",
  "scope": {},
  "expectedState": "TASK_STATE_AUTH_REQUIRED",
  "expectedActionFingerprint": "<sha256-hex>",
  "claimId": "<unique-claim-id>"
}
```

Response perdedor:

```json
{ "claim": null }
```

Response ganador:

```json
{
  "claim": {
    "claimId": "<same-claim-id>",
    "record": {}
  }
}
```

La operación en Platform debe ser atómica. Solo puede ganar si, en una única transacción/CAS autoritativa:

1. existe el `taskId` en el scope exacto;
2. no hay claim activo;
3. el estado coincide con `expectedState`;
4. el `actionFingerprint` coincide exactamente;
5. Platform persiste el `claimId` y mueve la tarea a `TASK_STATE_WORKING` antes de responder.

Los claims no expiran automáticamente. Si un runtime cae después del claim y antes de completar, el estado queda bloqueado para reconciliación explícita en lugar de arriesgar una segunda ejecución mutante.

#### Complete

Request:

```json
{
  "version": "kab.a2a-task-complete.v1",
  "claim": {},
  "record": {}
}
```

Response:

```json
{ "completed": true }
```

`completed=true` solo es válido si Platform sustituye el record mediante comparación atómica contra el `claimId` persistido y el mismo scope. Un claim distinto, inexistente o ya consumido devuelve `completed=false`.

### Responsabilidad de Platform

La implementación del endpoint en Kairoseth Platform debe proporcionar la atomicidad real entre nodos. Puede usar el datastore autoritativo existente de Platform; la elección concreta de tecnología permanece fuera del runtime Agent Bridge.

No se considera completado el ítem clustered/shared únicamente por disponer del cliente HTTP: también debe existir la implementación Platform y una prueba de aceptación con al menos dos instancias lógicas compitiendo por el mismo claim.

---

## EN — Authoritative backend for clustered deployments

`PlatformA2ATaskStore` is the shared A2A storage client for Kairoseth Agent Bridge runtimes that may execute on more than one node.

**Kairoseth Platform** remains authoritative. Agent Bridge does not create a second tenant database or require customers to install Redis, MongoDB or PostgreSQL merely to coordinate A2A tasks.

### Principles

- communication is outbound from Agent Bridge to Platform;
- the authenticated Bridge session token is reused through an `accessToken` provider;
- the token is resolved again for every operation so session renewal is supported;
- there is no automatic fallback to memory or local disk when Platform is unavailable;
- `save`, `get`, `claimTransition` and `completeTransition` use `POST`, `Cache-Control: no-store` and blocked redirects;
- HTTPS is required outside local development;
- transport failures, malformed responses and binding mismatches fail closed;
- the client does not automatically retry transition operations.

### v1 endpoints

Default paths:

```text
POST /api/products/agent-bridge/a2a/tasks/save
POST /api/products/agent-bridge/a2a/tasks/get
POST /api/products/agent-bridge/a2a/tasks/claim
POST /api/products/agent-bridge/a2a/tasks/complete
```

All endpoints require `Authorization: Bearer <bridge-session-token>`.

The request and response bodies are the same versioned contracts shown in the ES section above.

For `claim`, Platform must atomically verify exact task ID, actor/tenant/installation scope, expected task state, exact action fingerprint and absence of an active claim, then persist the claim and `TASK_STATE_WORKING` before returning the winner.

For `complete`, Platform must atomically compare the persisted claim ID and exact scope before replacing the task with the terminal record. A missing, stale or different claim returns `completed=false`.

Claims deliberately have no automatic expiry. An uncertain crash remains fail-closed and requires explicit reconciliation rather than risking duplicate WRITE/CRITICAL execution.

### Platform responsibility

The Kairoseth Platform endpoint implementation provides the real cross-node atomicity and should reuse Platform's existing authoritative datastore. The concrete datastore technology is not imposed on the Agent Bridge runtime.

The clustered/shared Phase 6 item is only complete after the Platform-side implementation exists and an acceptance test proves at least two logical runtime instances competing for the same claim produce exactly one winner.

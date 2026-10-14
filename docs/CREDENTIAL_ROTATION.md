# Kairoseth Agent Bridge — Credential Rotation Hooks

## ES — Español

### Objetivo

Credential Rotation Hooks permite que una instancia de Kairoseth Agent Bridge adopte credenciales nuevas sin reiniciar el runtime y sin transportar valores secretos a través del contrato de rotación.

Aplica a credenciales de conectores como:

- API keys;
- bearer tokens;
- usuario/password;
- OAuth2 almacenado por un backend autorizado;
- credenciales de base de datos;
- certificados;
- credenciales custom declaradas por el Connector SDK.

La rotación es un mecanismo de runtime. No sustituye el sistema que almacena, genera, revoca o distribuye el secreto real.

### Superficie en Kairoseth Platform

La gestión operativa de Agent Bridge se integrará dentro de:

```text
Kairoseth Platform
  -> IA
     -> Agent Bridge
        -> Instalación
           -> Conector
              -> Credenciales
```

La Platform puede iniciar o reflejar una rotación, pero el aviso enviado al Bridge contiene únicamente metadatos. El valor de la credencial permanece en el SecretProvider/backend autorizado correspondiente.

### Contrato metadata-only

Una rotación se representa con `ConnectorCredentialRotationNotice`:

```ts
{
  rotationId: "rot-2026-10-14-001",
  requirementId: "api",
  fieldIds: ["token"],
  rotatedAt: "2026-10-14T10:00:00.000Z",
  revision: "vault-rev-42"
}
```

Nunca incluye:

- token;
- password;
- API key;
- private key;
- certificado privado;
- connection string con secretos;
- payload arbitrario del proveedor.

El runtime rechaza campos no soportados, IDs inválidos, requirements inexistentes, fields no declarados, fields duplicados y metadata fuera de límites.

### Orden correcto

La secuencia segura es:

1. el backend autorizado actualiza/activa la credencial real;
2. Kairoseth emite el aviso metadata-only;
3. Agent Bridge bloquea nuevas ejecuciones de esa instancia;
4. el SecretProvider refresca/invalida su vista si implementa `refreshCredentials()`;
5. el conector ejecuta `credentialsRotated()` si necesita reconstruir un cliente, pool o handle;
6. al completar ambos pasos, el bloqueo se elimina;
7. las siguientes ejecuciones resuelven la credencial actual.

El campo `revision` es solamente metadata de correlación. Un SecretProvider no debe utilizarlo para recuperar deliberadamente una versión histórica del secreto. El refresh debe resolver el secreto actualmente activo.

### SecretProvider

El contrato existente `ConnectorSecretProvider` sigue siendo compatible.

Proveedor live:

```ts
{
  getSecret(requirementId, fieldId) { ... }
}
```

Si no declara `refreshCredentials()`, debe resolver el valor actual en cada `getSecret()` y no mantener un cache indefinido.

Proveedor con cache/handle:

```ts
{
  getSecret(requirementId, fieldId) { ... },
  refreshCredentials(notice, context) { ... }
}
```

`refreshCredentials()` recibe `AbortSignal` y debe respetarlo cuando la librería/backend lo permita.

### Hook del conector

Un conector puede declarar:

```ts
credentialsRotated(notice, context)
```

Se ejecuta después del refresh del SecretProvider.

Sirve para:

- reconstruir un SDK client;
- cerrar/recrear un connection pool;
- invalidar una sesión autenticada;
- recargar un certificado;
- limpiar caches derivados de credenciales.

El hook no recibe el secreto directamente. Si necesita una credencial debe solicitarla de nuevo a `context.secrets`.

### Fail-closed

Desde que comienza una rotación, las nuevas tool calls de la instancia quedan bloqueadas.

Estados runtime:

- `idle` — no existe una rotación activa;
- `refreshing` — provider/hook están aplicando la rotación;
- `blocked` — la aplicación falló o expiró y requiere reintento/remediación.

Si provider o connector hook fallan:

- Agent Bridge no vuelve silenciosamente a la credencial antigua;
- la instancia permanece bloqueada;
- el error público es genérico;
- el mensaje raw del backend no se propaga;
- health muestra `credential_rotation` y las tools aparecen `blocked` con `blockedReason = credential_rotation`.

Esto evita que un error como `authorization=<secret>` termine en UI, audit o observabilidad.

### Timeout duro

La aplicación de la rotación tiene un timeout independiente del tool timeout y del health timeout.

Default:

```text
10 segundos
```

El runtime usa `Promise.race`, por lo que vuelve a control aunque un provider/hook defectuoso ignore `AbortSignal`.

Si ocurre timeout:

```text
status = blocked
failureReason = timeout
```

La instancia sigue fail-closed hasta que una rotación/reintento válido termine correctamente.

### Idempotencia

Los `rotationId` aplicados se recuerdan en una cache acotada del proceso.

Una redelivery del mismo `rotationId` ya aplicado devuelve el mismo receipt sin volver a ejecutar provider/hook.

Este baseline es deliberadamente acotado e in-process. En despliegues donde la redelivery pueda cruzar procesos/restarts, la deduplicación durable puede apoyarse además en el canal de comandos durable de Kairoseth Platform.

Los hooks de provider/conector deben ser idempotentes porque un proceso puede reiniciarse después de una aplicación remota pero antes de persistir/confirmar el ACK externo.

### Health

Mientras `refreshing` o `blocked`:

- el Bridge no ejecuta el health probe remoto del conector;
- evita que el propio probe utilice una credencial posiblemente obsoleta;
- el snapshot de instancia es `unhealthy`;
- todas las tools aparecen bloqueadas por `credential_rotation`.

Al completar la rotación, el health normal vuelve a funcionar.

### Ejecuciones ya iniciadas

El gate bloquea nuevas ejecuciones desde que Agent Bridge recibe el aviso.

Una operación que ya estaba ejecutándose antes del aviso no puede cancelarse de forma universal porque algunos SDK/backends no soportan cancelación segura. La revocación inmediata de la credencial antigua sigue siendo responsabilidad del sistema de credenciales/upstream cuando el escenario lo requiera.

### Seguridad

Credential Rotation Hooks no cambia:

- tenant binding;
- installation identity;
- READ / WRITE / CRITICAL;
- policy;
- signed approval;
- command idempotency;
- approval replay protection;
- audit.

Una rotación correcta no concede permisos nuevos. Solo actualiza la credencial que un conector autorizado puede resolver.

### ES/EN

Los códigos técnicos (`idle`, `refreshing`, `blocked`, `apply_failed`, `timeout`, `credential_rotation`) son estables e independientes del idioma.

Kairoseth Platform debe presentar sus labels/mensajes en ES/EN dentro de la sección IA > Agent Bridge.

---

## EN — English

### Goal

Credential Rotation Hooks lets a Kairoseth Agent Bridge connector instance adopt new credentials without restarting the runtime and without carrying secret values in the rotation contract.

It applies to connector credentials such as:

- API keys;
- bearer tokens;
- username/password;
- OAuth2 material stored by an authorized backend;
- database credentials;
- certificates;
- custom credentials declared by the Connector SDK.

Rotation is a runtime mechanism. It does not replace the system that stores, generates, revokes or distributes the actual secret.

### Kairoseth Platform surface

Agent Bridge operations will be integrated under:

```text
Kairoseth Platform
  -> AI
     -> Agent Bridge
        -> Installation
           -> Connector
              -> Credentials
```

The Platform may initiate or reflect a rotation, but the notice sent to the Bridge contains metadata only. Credential values remain in the relevant authorized SecretProvider/backend.

### Metadata-only contract

A rotation is represented by `ConnectorCredentialRotationNotice`:

```ts
{
  rotationId: "rot-2026-10-14-001",
  requirementId: "api",
  fieldIds: ["token"],
  rotatedAt: "2026-10-14T10:00:00.000Z",
  revision: "vault-rev-42"
}
```

It never contains a token, password, API key, private key, private certificate material, secret-bearing connection string or arbitrary provider payload.

The runtime rejects unsupported fields, invalid IDs, undeclared requirements/fields, duplicate fields and out-of-bounds metadata.

### Correct ordering

The safe sequence is:

1. the authorized backend updates/activates the actual credential;
2. Kairoseth emits the metadata-only notice;
3. Agent Bridge blocks new executions for the connector instance;
4. the SecretProvider refreshes/invalidates its view when `refreshCredentials()` is implemented;
5. the connector runs `credentialsRotated()` when it must rebuild a client, pool or handle;
6. the execution block is removed only after both steps complete;
7. subsequent executions resolve the current credential.

`revision` is correlation metadata only. A SecretProvider must not use it to deliberately reload a historical secret version. Refresh must resolve the currently active secret.

### SecretProvider

The existing `ConnectorSecretProvider` remains backwards compatible.

A provider without `refreshCredentials()` must resolve the current value on each `getSecret()` call and must not keep an indefinite credential cache.

A provider with cached state may implement `refreshCredentials(notice, context)` to invalidate/reload that state. The refresh context includes an `AbortSignal`.

### Connector hook

A connector may implement `credentialsRotated(notice, context)` after SecretProvider refresh.

Typical uses include rebuilding SDK clients, recreating connection pools, invalidating authenticated sessions, reloading certificates and clearing credential-derived caches.

The hook does not receive credential values. It must request current values again through `context.secrets` when needed.

### Fail-closed behavior

From the moment rotation starts, new tool calls for the instance are blocked.

Runtime states are:

- `idle` — no active rotation;
- `refreshing` — provider/connector hooks are applying the rotation;
- `blocked` — application failed or timed out and requires retry/remediation.

If the provider or connector hook fails, Agent Bridge does not silently continue with the old credential. The instance remains blocked, public errors are generic, raw backend errors are not propagated, and health exposes a safe `credential_rotation` reason.

### Hard timeout

Credential rotation has its own bounded timeout, separate from tool and health timeouts.

Default:

```text
10 seconds
```

The runtime uses `Promise.race`, so control returns even when a defective provider/hook ignores its `AbortSignal`.

A timeout leaves the instance blocked with `failureReason = timeout` until a valid retry succeeds.

### Idempotency

Applied `rotationId` receipts are retained in a bounded in-process cache. Redelivery of an already-applied ID returns the existing receipt without rerunning provider/connector hooks.

Deployments that need durable cross-process/restart deduplication can additionally rely on the Kairoseth Platform durable command channel. Provider/connector hooks must remain idempotent across process restart boundaries.

### Health

While credential rotation is `refreshing` or `blocked`, the Bridge skips the connector remote health probe so the probe cannot use a potentially stale credential. The instance reports `unhealthy` and tools report `blocked` with `blockedReason = credential_rotation`.

Normal health probing resumes after a successful rotation.

### Already-running executions

The gate blocks new executions once the notice reaches Agent Bridge. An operation that started before the notice cannot be universally cancelled because not every backend/SDK supports safe cancellation. Immediate revocation of the old credential remains an upstream credential-system responsibility when required.

### Security boundary

Credential Rotation Hooks does not change tenant binding, installation identity, risk classification, policy, signed approval, command idempotency, approval replay protection or audit.

A successful rotation grants no new permission. It only updates the credential view available to an already-authorized connector.

### ES/EN

Technical codes (`idle`, `refreshing`, `blocked`, `apply_failed`, `timeout`, `credential_rotation`) are stable and locale-independent. Kairoseth Platform renders their operator copy in ES/EN under AI > Agent Bridge.

# Shared Replay & Idempotency / Replay e idempotencia compartidos

## ES

### Objetivo

Cuando Kairoseth Agent Bridge se ejecuta en más de un proceso, contenedor o nodo, la deduplicación local ya no es suficiente. Dos runtimes pueden recibir el mismo comando o approval al mismo tiempo.

El contrato compartido exige que la decisión de "quién gana" ocurra **atómicamente en el backend común** antes de ejecutar una mutación.

### CommandReceiptStore

`CommandProcessor` usa ahora este flujo:

1. validar el comando y su action fingerprint;
2. crear un receipt `processing`;
3. ejecutar `claim(processing)`;
4. solo el caller que recibe `claimed: true` puede ejecutar la tool;
5. finalizar mediante `complete(completed)`;
6. cualquier otro caller devuelve `indeterminate`, `duplicate` o `rejected` según el receipt existente.

`claim()` debe ser create-if-absent atómico por `commandId`.

`complete()` debe actuar como compare-and-set: solo puede convertir el claim correspondiente — mismo `commandId`, mismo `actionFingerprint` y mismo `startedAt` — en `completed`.

Nunca implementar:

`GET commandId -> no existe -> INSERT processing`

como dos operaciones independientes. Ese patrón permite doble ejecución bajo carrera.

### ApprovalReplayStore

`consume(record)` debe ser atómico por nonce. Exactamente un caller puede recibir `true`; todos los concurrentes o posteriores para el mismo nonce deben recibir `false`.

No basta con hacer `get(nonce)` antes de `insert`.

### Backends compartidos

Ejemplos válidos de implementación:

- **Redis**: `SET key value NX PX ...` para claim/nonce, y Lua/transaction/compare-and-set para completar receipts;
- **MongoDB**: índice único para `commandId` o `nonce`, `insertOne` para claim/consume y `updateOne` con filtro por fingerprint/estado/startedAt para completion;
- **SQL**: unique constraint + `INSERT ... ON CONFLICT DO NOTHING`, seguido de `UPDATE ... WHERE state='processing' AND action_fingerprint=? AND started_at=?`;
- otro datastore distribuido solo si ofrece la misma exclusión mutua/conditional-write de forma autoritativa.

Kairoseth Platform usa MongoDB actualmente, por lo que un adapter MongoDB es una opción natural para runtime hosted/shared. El core no depende de MongoDB: consume los contratos `CommandReceiptStore` y `ApprovalReplayStore`.

### Scope y namespaces

Las claves compartidas deben estar aisladas por el scope autoritativo correspondiente. Una implementación puede utilizar namespaces derivados de tenant/installation/bridge o collections/partitions equivalentes, pero nunca permitir que un caller no confiable elija el scope de seguridad.

`commandId` y approval `nonce` deben conservar unicidad durante toda su ventana de retención.

### Retención y pruning

Los records tienen `retainUntil`. La eliminación debe ocurrir solo después de esa fecha. Un backend con TTL index puede usarla como expiración automática; si no, debe ejecutar pruning periódico.

Eliminar un receipt/nonce demasiado pronto puede permitir un replay que todavía sea operacionalmente válido.

### Fallos

La política es fail-closed:

- si `claim()` no puede confirmar atomicidad, no se ejecuta la tool;
- si `consume()` falla, un approval mutante no se considera consumido válidamente y no habilita ejecución;
- si una ejecución comenzó y no existe completion confirmada, el estado `processing` produce `indeterminate`, no re-ejecución automática.

Esto evita prometer "exactly once". La garantía real es: **no ejecutar automáticamente una segunda vez cuando existe evidencia compartida de que la primera ejecución empezó o terminó**.

### Baselines locales

`InMemory*Store` es útil en tests y procesos únicos.

`FileCommandReceiptStore` y `FileApprovalReplayStore` serializan operaciones dentro de un proceso, pero no deben compartirse entre procesos/hosts como mecanismo clustered. Para clustering se requiere un backend con atomicidad propia.

## EN

### Purpose

When Kairoseth Agent Bridge runs in more than one process, container or node, local deduplication is not enough. Two runtimes may receive the same command or approval concurrently.

The shared contract requires the decision about "who wins" to happen **atomically in the common backend** before a mutation executes.

### CommandReceiptStore

`CommandProcessor` now uses this flow:

1. validate the command and action fingerprint;
2. create a `processing` receipt;
3. call `claim(processing)`;
4. only the caller receiving `claimed: true` may execute the tool;
5. finish through `complete(completed)`;
6. every other caller returns `indeterminate`, `duplicate` or `rejected` from the existing receipt.

`claim()` must be an atomic create-if-absent operation keyed by `commandId`.

`complete()` must behave as compare-and-set: only the matching claim — same `commandId`, `actionFingerprint` and `startedAt` — may transition to `completed`.

Never implement:

`GET commandId -> missing -> INSERT processing`

as separate operations. That pattern permits double execution under races.

### ApprovalReplayStore

`consume(record)` must be atomic per nonce. Exactly one caller may receive `true`; every concurrent or later caller for that nonce must receive `false`.

A `get(nonce)` followed by a separate insert is not sufficient.

### Shared backends

Valid implementation patterns include:

- **Redis**: `SET key value NX PX ...` for claims/nonces and Lua/transaction/CAS for receipt completion;
- **MongoDB**: unique indexes for `commandId` or `nonce`, `insertOne` for claim/consume, and `updateOne` filtered by fingerprint/state/startedAt for completion;
- **SQL**: unique constraint + `INSERT ... ON CONFLICT DO NOTHING`, followed by `UPDATE ... WHERE state='processing' AND action_fingerprint=? AND started_at=?`;
- another distributed datastore only when it provides the same authoritative mutual exclusion/conditional-write semantics.

Kairoseth Platform currently uses MongoDB, so a MongoDB adapter is a natural option for hosted/shared runtime deployments. The core remains datastore-neutral and consumes `CommandReceiptStore` and `ApprovalReplayStore` contracts.

### Scope and namespaces

Shared keys must be isolated by the applicable authoritative scope. An implementation may use namespaces derived from tenant/installation/bridge or equivalent collections/partitions, but an untrusted caller must never choose the security scope.

`commandId` and approval `nonce` must remain unique for their complete retention window.

### Retention and pruning

Records contain `retainUntil`. Deletion must happen only after that timestamp. A datastore with TTL indexes may use automatic expiry; otherwise periodic pruning is required.

Deleting a receipt/nonce too early may re-enable replay while the original operation is still operationally relevant.

### Failure behavior

The policy is fail-closed:

- if `claim()` cannot confirm atomicity, the tool does not execute;
- if `consume()` fails, a mutating approval is not treated as safely consumed and does not enable execution;
- if execution started without confirmed completion, a `processing` receipt produces `indeterminate`, not automatic re-execution.

This deliberately avoids claiming "exactly once". The practical guarantee is: **do not automatically execute a second time when shared evidence shows that the first execution started or completed**.

### Local baselines

`InMemory*Store` is suitable for tests and single processes.

`FileCommandReceiptStore` and `FileApprovalReplayStore` serialize operations inside one process, but must not be shared across independent processes/hosts as a clustered mechanism. Clustering requires backend-level atomicity.

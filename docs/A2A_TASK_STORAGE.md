# A2A task storage / Almacenamiento de tareas A2A

## ES — Baseline durable single-node

`FileA2ATaskStore` proporciona persistencia durable para tareas A2A en una instalación de Agent Bridge de un solo nodo. Sustituye el almacenamiento en memoria cuando una tarea debe sobrevivir a reinicios del proceso, especialmente durante flujos `TASK_STATE_AUTH_REQUIRED` que se reanudan después de una aprobación.

Uso recomendado en un runtime A2A de producción single-node:

```ts
import {
  A2AToolExecutionAdapter,
  FileA2ATaskStore,
} from "kairoseth-agent-bridge";

const taskStore = new FileA2ATaskStore({
  filePath: "/var/lib/agent-bridge/a2a/tasks.json",
});

const a2a = new A2AToolExecutionAdapter(runtime, { taskStore });
```

Garantías de seguridad y durabilidad:

- cada lectura vuelve a validar el scope exacto `actor + tenantId + installationId`;
- un mismo `taskId` no puede reasignarse a otro scope de seguridad;
- las escrituras se serializan dentro del proceso y se publican mediante reemplazo atómico;
- el archivo temporal se sincroniza antes de activarse y se crea con modo `0600`;
- se rechaza un datastore que sea enlace simbólico o no sea un archivo regular;
- JSON corrupto, schema desconocido, IDs duplicados y records inválidos fallan de forma cerrada;
- `maxRecords` y `maxFileBytes` limitan crecimiento y lectura del estado durable;
- el payload recuperado se devuelve mediante copia estructurada para evitar mutaciones accidentales del estado persistido.

El datastore durable debe vivir fuera del directorio inmutable de la release. En los paquetes Linux actuales, `/var/lib/agent-bridge` es el lugar natural para estado persistente.

### Contrato atómico de reanudación

La reanudación de una tarea aprobada ya no usa un flujo inseguro `get -> execute -> save`. `A2ATaskStore` expone un contrato explícito:

1. `claimTransition(...)` reserva de forma atómica la transición desde `TASK_STATE_AUTH_REQUIRED`;
2. el claim queda ligado al `taskId`, scope de seguridad y `actionFingerprint` exacto;
3. el estado durable pasa a `TASK_STATE_WORKING` **antes** de ejecutar el side effect;
4. solo el ganador del claim puede llamar a la ejecución de BridgeRuntime;
5. `completeTransition(...)` publica el resultado solo si conserva el `claimId` exacto.

El claim no expira automáticamente. Si el proceso cae después de reservar la transición pero antes de conocer con certeza el resultado del side effect, la tarea queda `WORKING`/claimed y los reintentos fallan cerrados. Esto es intencional: una lease que expirase automáticamente podría permitir una segunda mutación mientras la primera ejecución sigue siendo incierta.

La recuperación de un claim incierto debe ser una acción explícita de reconciliación operativa, nunca una repetición automática del WRITE/CRITICAL.

`FileA2ATaskStore` usa schema durable `kab.a2a-task-store.v2`. Los archivos v1 existentes se leen de forma compatible y se migran a v2 en la siguiente escritura.

### Límite deliberado: cluster/shared

`FileA2ATaskStore` **no** se considera un backend clustered. Es adecuado para un runtime single-node con un único proceso activo sobre su estado local. Su cola interna no coordina dos procesos o dos hosts independientes.

Un despliegue multi-node debe inyectar otra implementación de `A2ATaskStore` respaldada por un datastore compartido y autoritativo. Esa implementación debe, como mínimo:

- aplicar unicidad global de `taskId`;
- impedir colisiones de scope de forma atómica;
- implementar `claimTransition` como compare-and-set/transacción global de un solo ganador;
- persistir el claim antes del side effect y hacer `completeTransition` condicional al mismo `claimId`;
- mantener un claim incierto fail-closed hasta reconciliación explícita;
- evitar fallback silencioso a memoria/local si el datastore compartido no está disponible;
- mantener el mismo aislamiento `actor + tenant + installation`;
- preservar `correlationId`, `actionFingerprint` y provenance exactamente durante pausa/reanudación;
- disponer de cifrado en reposo, backups y políticas de retención acordes al entorno del cliente.

El contrato atómico del runtime ya está definido y probado. Hasta que exista y se pruebe una implementación compartida que cumpla ese contrato **entre nodos**, el punto clustered de Fase 6 permanece abierto.

---

## EN — Durable single-node baseline

`FileA2ATaskStore` provides durable A2A task persistence for a single-node Agent Bridge installation. It replaces in-memory storage when tasks must survive process restarts, especially `TASK_STATE_AUTH_REQUIRED` flows that resume after approval.

Recommended use in a production single-node A2A runtime:

```ts
import {
  A2AToolExecutionAdapter,
  FileA2ATaskStore,
} from "kairoseth-agent-bridge";

const taskStore = new FileA2ATaskStore({
  filePath: "/var/lib/agent-bridge/a2a/tasks.json",
});

const a2a = new A2AToolExecutionAdapter(runtime, { taskStore });
```

Security and durability guarantees:

- every read revalidates the exact `actor + tenantId + installationId` scope;
- a `taskId` cannot be reassigned to another security scope;
- writes are serialized inside the process and published through atomic replacement;
- the temporary file is synced before activation and created with mode `0600`;
- symbolic-link or non-regular-file datastore targets are rejected;
- corrupt JSON, unknown schema, duplicate IDs and invalid records fail closed;
- `maxRecords` and `maxFileBytes` bound durable-state growth and reads;
- restored records are returned as structured clones to prevent accidental mutation of persisted state.

Durable state must live outside the immutable release directory. With the current Linux packages, `/var/lib/agent-bridge` is the natural persistent-state location.

### Atomic resume-transition contract

Approved-task resume no longer uses an unsafe `get -> execute -> save` sequence. `A2ATaskStore` now exposes an explicit contract:

1. `claimTransition(...)` atomically reserves the transition from `TASK_STATE_AUTH_REQUIRED`;
2. the claim is bound to the exact `taskId`, security scope and `actionFingerprint`;
3. durable state moves to `TASK_STATE_WORKING` **before** the side effect executes;
4. only the claim winner may invoke BridgeRuntime;
5. `completeTransition(...)` publishes the result only while holding the exact `claimId`.

Claims deliberately do not expire automatically. If a process crashes after reserving the transition but before the side-effect outcome is known, the task remains `WORKING`/claimed and retries fail closed. An automatically expiring lease could otherwise allow a second mutation while the first execution is still uncertain.

Recovering an uncertain claim must therefore be an explicit operator reconciliation action, never an automatic WRITE/CRITICAL retry.

`FileA2ATaskStore` now persists schema `kab.a2a-task-store.v2`. Existing v1 files remain readable and are migrated to v2 on the next write.

### Deliberate boundary: clustered/shared storage

`FileA2ATaskStore` is **not** a clustered backend. It is intended for a single-node runtime with one active process over local state. Its internal queue does not coordinate independent processes or hosts.

A multi-node deployment must inject another `A2ATaskStore` implementation backed by an authoritative shared datastore. At minimum, that implementation must:

- enforce global `taskId` uniqueness;
- reject cross-scope collisions atomically;
- implement `claimTransition` as a global single-winner compare-and-set/transaction;
- persist the claim before the side effect and condition `completeTransition` on the same `claimId`;
- keep uncertain claims fail-closed until explicit reconciliation;
- never silently fall back to memory/local state when the shared datastore is unavailable;
- preserve the same `actor + tenant + installation` isolation;
- preserve `correlationId`, `actionFingerprint` and provenance exactly across pause/resume;
- provide encryption at rest, backup and retention controls appropriate to the customer environment.

The runtime atomic-transition contract is now defined and tested. Until a shared implementation satisfies and passes this contract **across nodes**, the clustered Phase 6 item remains open.

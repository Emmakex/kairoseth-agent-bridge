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

### Límite deliberado: cluster/shared

`FileA2ATaskStore` **no** se considera un backend clustered. Es adecuado para un runtime single-node con un único proceso activo sobre su estado local.

Un despliegue multi-node debe inyectar otra implementación de `A2ATaskStore` respaldada por un datastore compartido y autoritativo. Esa implementación debe, como mínimo:

- aplicar unicidad global de `taskId`;
- impedir colisiones de scope de forma atómica;
- ofrecer compare-and-set o una transacción equivalente para las transiciones de tarea;
- evitar fallback silencioso a memoria/local si el datastore compartido no está disponible;
- mantener el mismo aislamiento `actor + tenant + installation`;
- preservar `correlationId`, `actionFingerprint` y provenance exactamente durante pausa/reanudación;
- disponer de cifrado en reposo, backups y políticas de retención acordes al entorno del cliente.

Hasta que exista y se pruebe ese backend compartido, el punto clustered de Fase 6 permanece abierto.

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

### Deliberate boundary: clustered/shared storage

`FileA2ATaskStore` is **not** a clustered backend. It is intended for a single-node runtime with one active process over local state.

A multi-node deployment must inject another `A2ATaskStore` implementation backed by an authoritative shared datastore. At minimum, that implementation must:

- enforce global `taskId` uniqueness;
- reject cross-scope collisions atomically;
- provide compare-and-set or an equivalent transaction for task transitions;
- never silently fall back to memory/local state when the shared datastore is unavailable;
- preserve the same `actor + tenant + installation` isolation;
- preserve `correlationId`, `actionFingerprint` and provenance exactly across pause/resume;
- provide encryption at rest, backup and retention controls appropriate to the customer environment.

Until that shared backend exists and is acceptance-tested, the clustered Phase 6 item remains open.

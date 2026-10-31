# Phase 7 — Real stable-artifact acceptance closure

Status: **complete**

Phase 7 is closed by a real execution of the published `v0.1.4` Agent Bridge artifact against the live Kairoseth Platform control plane and a disposable WooCommerce instance.

---

## ES

### Evidencia canónica

- Agent Bridge release: `v0.1.4`
- Source commit exacto: `595fbddb38562caf4cf0a888fc22deb6524e8732`
- Runtime archive: `agent-bridge-0.1.4-595fbddb3856.tar.gz`
- SHA-256 del runtime archive: `de222c168699a8c00eae6a656273e559837348565a665e8bd5c886ca65c01e9d`
- Tag estable: anotado, firmado y `verified=true` en GitHub
- Stable Release Promotion: success, sin reconstruir los bytes promovidos
- Kairoseth Command Center main: `988193261dcc2858606a027af01c6891d765540b`
- Workflow real: `Agent Bridge Phase 7 Stable Acceptance`, run `41194834996`
- Evidencia sanitizada: artifact `agent-bridge-phase7-stable-acceptance-988193261dcc2858606a027af01c6891d765540b`, artifact ID `13040885139`
- Digest del ZIP de evidencia de GitHub Actions: `sha256:5bb24318035918594763daf3b9a5c8ffcd1614c1f78d26d3f748b7ed861d46c5`

El digest del ZIP de evidencia es distinto del SHA-256 del runtime archive y no lo sustituye. El runtime ejecutado queda ligado al digest `de222c...01e9d`.

### Resultado real

La evidencia sanitizada confirma:

- `result = passed`;
- `runtimeVersion = 0.1.4`;
- digest del artefacto estable exacto validado antes de ejecutar;
- enrollment y sesión reales contra Kairoseth Platform;
- observabilidad `connected + ready` con `connectorCount = 1` y `toolCount = 6` antes y después del reinicio;
- WooCommerce READ real ejecutado con `deliveryAttempt = 1` y precondición esperada válida;
- WooCommerce WRITE real aprobado y ejecutado con `deliveryAttempt = 1` y estado objetivo validado;
- identidad y binding preservados tras reinicio;
- comandos completados no redeliverados;
- audit outbox drenado;
- escaneo del estado durable sin secretos: `passed`.

La prueba usa un WooCommerce real pero desechable creado por el workflow; no toca pedidos de clientes y no conserva credenciales, payloads WooCommerce ni IDs de pedidos en esta documentación.

### Hallazgos que endurecieron el gate

Las ejecuciones reales previas encontraron y corrigieron cuatro diferencias entre simulación y entorno real sin debilitar la política fail-closed:

1. `v0.1.1`: el heartbeat podía verse `ready` antes del inventario de conectores/tools; el runner ahora espera inventario real.
2. `v0.1.2`: la superficie saneada del operador elimina `correlationId`; Agent Bridge dejó de exigirlo en esa proyección.
3. `v0.1.3`: Generic REST devuelve `{ status, ok, body }`; la precondición WooCommerce exige `ok === true` y usa `body.status`.
4. Primera ejecución de `v0.1.4`: la aceptación funcional ya pasó, pero el workflow no pudo leer/copiar la evidencia porque el contenedor escribió bind mounts como `root`. Kairoseth Command Center PR #94 ejecuta el contenedor con UID/GID del runner; no cambia el artefacto `v0.1.4` ni su semántica funcional.

### Condición de salida

**Cumplida.** El mismo artefacto estable publicado y verificado ejecuta el flujo real `enrollment -> observability -> READ -> approved WRITE -> audit -> restart -> non-redelivery` sin bypass de política, con evidencia sanitizada durable.

El siguiente trabajo ya no es ampliar Phase 7: es consumir el bridge desde los productos mediante los contratos compartidos, siguiendo el orden de integración del roadmap y sin crear runtimes privados por producto.

---

## EN

### Canonical evidence

- Agent Bridge release: `v0.1.4`
- Exact source commit: `595fbddb38562caf4cf0a888fc22deb6524e8732`
- Runtime archive: `agent-bridge-0.1.4-595fbddb3856.tar.gz`
- Runtime archive SHA-256: `de222c168699a8c00eae6a656273e559837348565a665e8bd5c886ca65c01e9d`
- Stable tag: annotated, signed and GitHub `verified=true`
- Stable Release Promotion: successful, with no rebuild of promoted bytes
- Kairoseth Command Center main: `988193261dcc2858606a027af01c6891d765540b`
- Real workflow: `Agent Bridge Phase 7 Stable Acceptance`, run `41194834996`
- Sanitized evidence: artifact `agent-bridge-phase7-stable-acceptance-988193261dcc2858606a027af01c6891d765540b`, artifact ID `13040885139`
- GitHub Actions evidence ZIP digest: `sha256:5bb24318035918594763daf3b9a5c8ffcd1614c1f78d26d3f748b7ed861d46c5`

The evidence ZIP digest is distinct from the runtime archive SHA-256 and does not replace it. The executed runtime remains bound to `de222c...01e9d`.

### Real result

The sanitized evidence confirms:

- `result = passed`;
- `runtimeVersion = 0.1.4`;
- exact stable artifact digest verified before execution;
- real enrollment and session against Kairoseth Platform;
- `connected + ready` observability with `connectorCount = 1` and `toolCount = 6` before and after restart;
- real WooCommerce READ executed with `deliveryAttempt = 1` and the expected precondition matched;
- real approved WooCommerce WRITE executed with `deliveryAttempt = 1` and the target state matched;
- identity and binding preserved across restart;
- completed commands not redelivered;
- audit outbox drained;
- durable-state secret scan: `passed`.

The workflow uses a real but disposable WooCommerce instance. It does not touch customer orders and this documentation does not retain credentials, WooCommerce payloads or order IDs.

### Findings that hardened the gate

Earlier real executions found and fixed four simulation-to-reality differences without weakening fail-closed behavior:

1. `v0.1.1`: heartbeat readiness could appear before connector/tool inventory; the runner now waits for real inventory.
2. `v0.1.2`: the sanitized operator projection intentionally redacts `correlationId`; Agent Bridge no longer requires it there.
3. `v0.1.3`: Generic REST returns `{ status, ok, body }`; the WooCommerce precondition requires `ok === true` and reads `body.status`.
4. First `v0.1.4` run: functional acceptance already passed, but workflow post-processing could not read/copy root-owned bind-mounted evidence. Kairoseth Command Center PR #94 runs the acceptance container with the runner UID/GID; it does not change the `v0.1.4` artifact or acceptance semantics.

### Exit condition

**Achieved.** The same published and verified stable artifact executes the real `enrollment -> observability -> READ -> approved WRITE -> audit -> restart -> non-redelivery` path without policy bypass and produces durable sanitized evidence.

The next work is product consumption through the shared bridge contracts, following the roadmap integration order without creating private per-product runtimes.

# Phase 7.3 — Stable artifact real-environment acceptance

Status: **complete — v0.1.4 accepted in the real environment**

Phase 7.3 is closed by the published `v0.1.4` Agent Bridge artifact running against the real Kairoseth Platform control plane and a disposable WooCommerce environment. Canonical closure evidence is recorded in `docs/PHASE_7_CLOSURE.md`.

---

## ES

### Release aceptada

- Release: `v0.1.4`
- Source commit: `595fbddb38562caf4cf0a888fc22deb6524e8732`
- Runtime archive: `agent-bridge-0.1.4-595fbddb3856.tar.gz`
- SHA-256: `de222c168699a8c00eae6a656273e559837348565a665e8bd5c886ca65c01e9d`
- Tag: anotado, firmado y verificado por GitHub
- Stable Release Promotion: success, sin rebuild
- Ejecución real final: Kairoseth Command Center workflow run `41194834996`
- Evidencia sanitizada: artifact ID `13040885139`

### Evolución del gate real

`v0.1.0` no era elegible porque precedía al runner de Phase 7.2.

`v0.1.1` descubrió una carrera entre heartbeat e inventario. El runner quedó endurecido para no emitir comandos hasta observar inventario real de conectores y tools.

`v0.1.2` descubrió que Kairoseth Platform elimina deliberadamente `correlationId` de la proyección saneada del operador. Agent Bridge dejó de exigir ese campo sin modificar la autoridad de Platform.

`v0.1.3` descubrió el contrato real de salida de Generic REST: `{ status, ok, body }`. La precondición WooCommerce quedó fail-closed sobre `output.ok === true` y `output.body.status`.

La primera ejecución de `v0.1.4` completó correctamente toda la aceptación funcional, pero falló después al leer/copiar evidencia escrita por el contenedor como `root`. Kairoseth Command Center PR #94 corrigió únicamente el UID/GID del contenedor de aceptación. El artefacto `v0.1.4`, su digest y la semántica funcional no cambiaron.

### Gates obligatorios — cumplidos

1. [x] El source commit pertenece a `main`.
2. [x] `npm run check` está verde.
3. [x] El build contiene `dist/src/cli/agent-bridge-runtime.js`.
4. [x] El build contiene `dist/src/cli/phase7-real-platform-acceptance.js`.
5. [x] La versión reportada se deriva del `package.json` empaquetado y una versión declarada distinta falla cerrada.
6. [x] El runtime no se considera command-ready hasta observar al menos un conector y un tool en Platform.
7. [x] La proyección saneada del operador funciona sin exigir `correlationId` expuesto.
8. [x] La precondición WooCommerce usa el contrato Generic REST real: `output.ok === true` y `output.body.status`.
9. [x] Release Integrity genera y atesta el artefacto exacto.
10. [x] La promoción estable usa un tag anotado firmado y verificado sin reconstruir bytes.
11. [x] El SHA-256 del archive estable se verifica antes de ejecutar y se liga a la evidencia.
12. [x] La aceptación se ejecuta desde el archive estable extraído, no desde un checkout de desarrollo.
13. [x] La evidencia sanitizada queda persistida como artifact del workflow.

### Resultado de salida

La evidencia final confirma READ real y WRITE aprobado con `deliveryAttempt=1`, observabilidad con inventario antes y después del reinicio, identidad y binding preservados, no redelivery de comandos completados, audit outbox drenado y escaneo durable sin secretos.

**Phase 7.3 y Phase 7 quedan cerradas.**

---

## EN

### Accepted release

- Release: `v0.1.4`
- Source commit: `595fbddb38562caf4cf0a888fc22deb6524e8732`
- Runtime archive: `agent-bridge-0.1.4-595fbddb3856.tar.gz`
- SHA-256: `de222c168699a8c00eae6a656273e559837348565a665e8bd5c886ca65c01e9d`
- Tag: annotated, signed and GitHub-verified
- Stable Release Promotion: successful, without rebuild
- Final real execution: Kairoseth Command Center workflow run `41194834996`
- Sanitized evidence: artifact ID `13040885139`

### Real-gate evolution

`v0.1.0` was not eligible because it predated the Phase 7.2 runner.

`v0.1.1` exposed a heartbeat/inventory race. The runner was hardened so commands are not queued until real connector/tool inventory is visible in Platform.

`v0.1.2` exposed that Kairoseth Platform deliberately redacts `correlationId` from the sanitized operator projection. Agent Bridge stopped requiring that field without changing Platform authority.

`v0.1.3` exposed the real Generic REST output contract: `{ status, ok, body }`. The WooCommerce precondition remains fail-closed on `output.ok === true` and `output.body.status`.

The first `v0.1.4` execution completed the entire functional acceptance successfully, then failed only while reading/copying evidence written by the container as `root`. Kairoseth Command Center PR #94 changed only the acceptance container UID/GID. The `v0.1.4` artifact, digest and functional semantics did not change.

### Mandatory gates — achieved

1. [x] Source commit belongs to `main`.
2. [x] `npm run check` is green.
3. [x] Build contains `dist/src/cli/agent-bridge-runtime.js`.
4. [x] Build contains `dist/src/cli/phase7-real-platform-acceptance.js`.
5. [x] Runtime version derives from packaged `package.json`; a conflicting declared version fails closed.
6. [x] Runtime is not command-ready until Platform reports at least one connector and one tool.
7. [x] Sanitized operator projection is accepted without requiring exposed `correlationId`.
8. [x] WooCommerce precondition uses the real Generic REST contract: `output.ok === true` and `output.body.status`.
9. [x] Release Integrity generates and attests the exact artifact.
10. [x] Stable promotion uses a signed, verified annotated tag without rebuilding bytes.
11. [x] Stable archive SHA-256 is verified before execution and bound into evidence.
12. [x] Acceptance runs from the extracted stable archive, not a development checkout.
13. [x] Sanitized evidence is retained as a workflow artifact.

### Exit result

Final evidence confirms a real READ and approved WRITE with `deliveryAttempt=1`, inventory-backed observability before and after restart, preserved identity and binding, no completed-command redelivery, drained audit outbox and a clean durable-state secret scan.

**Phase 7.3 and Phase 7 are complete.**

# Phase 7.3 — Stable artifact real-environment acceptance

Status: **in progress — v0.1.4 release preparation**

Phase 7.3 closes only when the real Kairoseth Platform flow is executed from a published stable Agent Bridge artifact that contains the Phase 7 acceptance runner and has passed the real-environment contract conditions discovered during acceptance.

---

## ES

### Decisión de release

`v0.1.0` no puede utilizarse como evidencia de Phase 7.3. Ese release fue promovido desde `8d050215c97d2ac9428f35fc58c795e57f2a15a5`, antes de incorporar el runner de Phase 7.2.

`v0.1.1` tampoco puede cerrar Phase 7.3. La ejecución real contra Kairoseth Platform demostró una carrera en el runner: podía aceptar un runtime como `connected + ready` a partir del heartbeat antes de que Platform hubiese recibido el snapshot de inventario de conectores/tools. El READ se emitía demasiado pronto y Platform lo rechazaba correctamente con `409 agent_bridge_read_tool_unavailable`.

La corrección de `v0.1.2` mantuvo el control plane fail-closed: el runner espera a que la observabilidad del runtime incluya inventario real (`connectorCount > 0` y `toolCount > 0`) antes de emitir cualquier comando, tanto en el arranque inicial como después del reinicio controlado.

`v0.1.2` avanzó más en la ejecución real, pero tampoco puede cerrar Phase 7.3. El runner exigía `correlationId` en la proyección de comandos del operador. Kairoseth Platform elimina ese campo deliberadamente de la superficie saneada del operador y sus pruebas de seguridad exigen que no se exponga. Platform estaba cumpliendo correctamente su contrato; el defecto estaba en el parser de aceptación de Agent Bridge.

La corrección posterior no debilita Platform: `CommandProjection` y `commandFromResponse()` dejan de exigir `correlationId` en respuestas del operador. La aceptación continúa usando los correlation IDs generados localmente al emitir READ/WRITE para relacionar su propia evidencia, sin depender de que Platform los vuelva a exponer.

`v0.1.3` alcanzó correctamente el READ real de WooCommerce, pero tampoco puede cerrar Phase 7.3. La ejecución descubrió que el runner interpretaba incorrectamente el resultado del conector oficial: WooCommerce usa Generic REST y su contrato devuelve un envelope `{ status, ok, body }`. El runner comparaba `output.status` —el código HTTP— con el estado esperado del pedido, en lugar de comparar `output.body.status`.

La corrección para `v0.1.4` mantiene la precondición fail-closed antes del WRITE: exige `output.ok === true` y valida el estado real del pedido exclusivamente desde `output.body.status`. Las regresiones de Phase 7 usan ahora el mismo contrato de resultado que el conector real.

El primer artefacto elegible para cerrar 7.3 será `v0.1.4` o una versión estable posterior que cumpla todos los gates siguientes.

### Gates obligatorios

1. El source commit pertenece a `main`.
2. `npm run check` está verde.
3. El build contiene `dist/src/cli/agent-bridge-runtime.js`.
4. El build contiene `dist/src/cli/phase7-real-platform-acceptance.js`.
5. La versión que reporta el runner se resuelve desde el `package.json` empaquetado; una versión declarada distinta hace fallar la ejecución.
6. El runner no considera command-ready un runtime hasta observar al menos un conector y un tool en el inventario publicado por Platform.
7. La proyección saneada del operador se acepta sin exigir `correlationId`; ese campo continúa oculto por Platform.
8. La precondición WooCommerce interpreta el contrato Generic REST real: `output.ok === true` y estado en `output.body.status`.
9. Release Integrity genera y atesta el artefacto exacto de ese commit.
10. La promoción estable usa un tag anotado firmado y verificado por GitHub, sin reconstruir los bytes.
11. Antes de ejecutar 7.3 se verifica el SHA-256 del archive estable y se suministra ese digest como `KAB_ACCEPTANCE_ARTIFACT_SHA256`.
12. La aceptación se ejecuta desde el contenido extraído de ese mismo archive estable, no desde un checkout de desarrollo.

### Ejecución real

Desde el directorio extraído del artefacto estable verificado:

```bash
npm ci --omit=dev --no-audit --no-fund

export KAB_PLATFORM_BASE_URL='https://kairoseth.com/'
export KAB_STATE_DIR='/var/lib/agent-bridge-phase7'
export KAB_ACCEPTANCE_ARTIFACT_SHA256='sha256:<digest-verificado-del-archive>'

export KAB_ACCEPTANCE_WC_BASE_URL='https://woocommerce-controlado.example/'
export KAB_ACCEPTANCE_WC_ORDER_ID='1234'
export KAB_ACCEPTANCE_WC_EXPECTED_STATUS='processing'
export KAB_ACCEPTANCE_WC_TARGET_STATUS='completed'
export KAB_ACCEPTANCE_EVIDENCE_PATH='./artifacts/phase7-real-platform.json'

export KAB_ACCEPTANCE_OPERATOR_TOKEN_FILE='/run/secrets/kab-platform-operator-token'
export KAB_ACCEPTANCE_WC_CONSUMER_KEY_FILE='/run/secrets/kab-wc-consumer-key'
export KAB_ACCEPTANCE_WC_CONSUMER_SECRET_FILE='/run/secrets/kab-wc-consumer-secret'

npm run acceptance:phase7-platform
```

`KAB_ACCEPTANCE_RUNTIME_VERSION` deja de ser una fuente de verdad. Puede omitirse. Si se define, el CLI exige que coincida exactamente con la versión del `package.json` empaquetado.

### Evidencia mínima de cierre

Phase 7.3 queda cerrada únicamente con evidencia sanitizada de:

- versión estable realmente ejecutada;
- SHA-256 del artefacto estable verificado;
- enrollment y sesión contra Kairoseth Platform real;
- observabilidad con inventario de conectores/tools antes de emitir comandos y después del reinicio;
- proyección de operador compatible con el contrato saneado, sin requerir `correlationId` expuesto;
- WooCommerce READ real con envelope Generic REST válido y precondición esperada;
- WooCommerce WRITE real con aprobación y `deliveryAttempt=1`;
- auditoría drenada;
- identidad y binding preservados tras reinicio;
- comandos completados sin reentrega;
- escaneo de estado durable sin secretos.

No se conserva el ID del pedido, payloads WooCommerce ni credenciales.

---

## EN

### Release decision

`v0.1.0` cannot be used as Phase 7.3 evidence. That release was promoted from `8d050215c97d2ac9428f35fc58c795e57f2a15a5`, before the Phase 7.2 acceptance runner existed.

`v0.1.1` also cannot close Phase 7.3. The real Kairoseth Platform execution exposed a runner race: heartbeat-derived `connected + ready` could be accepted before Platform had received the connector/tool inventory snapshot. The runner could therefore queue the READ too early, and Platform correctly failed closed with `409 agent_bridge_read_tool_unavailable`.

The `v0.1.2` correction preserved the fail-closed control plane: the runner waits until runtime observability contains real inventory (`connectorCount > 0` and `toolCount > 0`) before any command is queued, both on initial startup and after the controlled restart.

`v0.1.2` progressed further in the real execution but also cannot close Phase 7.3. The runner required `correlationId` in the operator command projection. Kairoseth Platform deliberately removes that field from the sanitized operator surface, and its security acceptance requires it to remain absent. Platform was honoring its contract; the defect was in the Agent Bridge acceptance parser.

The subsequent fix does not weaken Platform: `CommandProjection` and `commandFromResponse()` no longer require `correlationId` from operator responses. Acceptance still uses the correlation IDs generated locally when it queues READ/WRITE commands to relate its own evidence, without requiring Platform to expose them back through the operator projection.

`v0.1.3` correctly reached the real WooCommerce READ but also cannot close Phase 7.3. The execution exposed a result-contract mismatch in the runner: the official WooCommerce connector uses Generic REST, whose execution contract returns an envelope `{ status, ok, body }`. The runner compared `output.status` —the HTTP status code— with the expected order state instead of reading `output.body.status`.

The `v0.1.4` correction keeps the pre-WRITE guard fail-closed: it requires `output.ok === true` and validates the actual order state exclusively from `output.body.status`. Phase 7 regression fixtures now mirror the real connector result contract.

The first artifact eligible to close 7.3 is `v0.1.4` or a later stable release that satisfies every gate below.

### Mandatory gates

1. The source commit belongs to `main`.
2. `npm run check` is green.
3. The build contains `dist/src/cli/agent-bridge-runtime.js`.
4. The build contains `dist/src/cli/phase7-real-platform-acceptance.js`.
5. The runner resolves its version from the packaged `package.json`; a conflicting declared version fails closed.
6. The runner does not consider a runtime command-ready until Platform observability reports at least one connector and one tool.
7. The sanitized operator projection is accepted without requiring `correlationId`; Platform continues to redact that field.
8. The WooCommerce precondition interprets the real Generic REST contract: `output.ok === true` and order state at `output.body.status`.
9. Release Integrity generates and attests the exact artifact for that commit.
10. Stable promotion uses a GitHub-verified signed annotated tag without rebuilding distribution bytes.
11. The stable archive SHA-256 is verified before 7.3 and supplied as `KAB_ACCEPTANCE_ARTIFACT_SHA256`.
12. Acceptance is run from the extracted contents of that same verified stable archive, not from a development checkout.

### Real execution

Run `npm ci --omit=dev --no-audit --no-fund` inside the verified extracted stable artifact, configure the same file-backed secrets and controlled WooCommerce variables documented above, then run:

```bash
npm run acceptance:phase7-platform
```

`KAB_ACCEPTANCE_RUNTIME_VERSION` is no longer a source of truth. It may be omitted; when present, the CLI requires an exact match with the packaged `package.json` version.

### Exit evidence

7.3 closes only when sanitized evidence proves the stable version and verified artifact digest, real Platform enrollment/session, inventory-backed observability before commands and after restart, compatibility with the sanitized operator projection without requiring an exposed `correlationId`, controlled WooCommerce READ with a valid Generic REST result envelope and expected precondition, approved WRITE, audit delivery, restart identity/binding preservation, completed-command non-redelivery and a clean durable-state secret scan.

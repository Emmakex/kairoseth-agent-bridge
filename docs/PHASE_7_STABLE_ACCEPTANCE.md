# Phase 7.3 — Stable artifact real-environment acceptance

Status: **in progress — release preparation**

Phase 7.3 closes only when the real Kairoseth Platform flow is executed from a published stable Agent Bridge artifact that actually contains the Phase 7 acceptance runner.

---

## ES

### Decisión de release

`v0.1.0` no puede utilizarse como evidencia de Phase 7.3. Ese release fue promovido desde `8d050215c97d2ac9428f35fc58c795e57f2a15a5`, antes de incorporar el runner de Phase 7.2.

El primer artefacto elegible para 7.3 será `v0.1.1` o una versión estable posterior que cumpla todos los gates siguientes.

### Gates obligatorios

1. El source commit pertenece a `main`.
2. `npm run check` está verde.
3. El build contiene `dist/src/cli/agent-bridge-runtime.js`.
4. El build contiene `dist/src/cli/phase7-real-platform-acceptance.js`.
5. La versión que reporta el runner se resuelve desde el `package.json` empaquetado; una versión declarada distinta hace fallar la ejecución.
6. Release Integrity genera y atesta el artefacto exacto de ese commit.
7. La promoción estable usa un tag anotado firmado y verificado por GitHub, sin reconstruir los bytes.
8. Antes de ejecutar 7.3 se verifica el SHA-256 del archive estable y se suministra ese digest como `KAB_ACCEPTANCE_ARTIFACT_SHA256`.
9. La aceptación se ejecuta desde el contenido extraído de ese mismo archive estable, no desde un checkout de desarrollo.

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
- observabilidad conectada antes y después del reinicio;
- WooCommerce READ real con precondición esperada;
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

The first artifact eligible for 7.3 is `v0.1.1` or a later stable release that satisfies every gate below.

### Mandatory gates

1. The source commit belongs to `main`.
2. `npm run check` is green.
3. The build contains `dist/src/cli/agent-bridge-runtime.js`.
4. The build contains `dist/src/cli/phase7-real-platform-acceptance.js`.
5. The runner resolves its version from the packaged `package.json`; a conflicting declared version fails closed.
6. Release Integrity generates and attests the exact artifact for that commit.
7. Stable promotion uses a GitHub-verified signed annotated tag without rebuilding distribution bytes.
8. The stable archive SHA-256 is verified before 7.3 and supplied as `KAB_ACCEPTANCE_ARTIFACT_SHA256`.
9. Acceptance is run from the extracted contents of that same verified stable archive, not from a development checkout.

### Real execution

Run `npm ci --omit=dev --no-audit --no-fund` inside the verified extracted stable artifact, configure the same file-backed secrets and controlled WooCommerce variables documented above, then run:

```bash
npm run acceptance:phase7-platform
```

`KAB_ACCEPTANCE_RUNTIME_VERSION` is no longer a source of truth. It may be omitted; when present, the CLI requires an exact match with the packaged `package.json` version.

### Exit evidence

7.3 closes only when sanitized evidence proves the stable version and verified artifact digest, real Platform enrollment/session/observability, controlled WooCommerce READ and approved WRITE, audit delivery, restart identity/binding preservation, completed-command non-redelivery and a clean durable-state secret scan.

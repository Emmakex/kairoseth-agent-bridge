# Phase 7.2 — Real Kairoseth Platform acceptance runner

Status: **implemented by this microphase; execution against a published stable artifact belongs to Phase 7.3**.

This runner turns the Phase 7 product-integration checklist into one reproducible command without storing Platform or WooCommerce credentials in Git, command-line arguments, retained evidence, or Agent Bridge durable state.

---

## ES

### Objetivo

Ejecutar de forma reproducible el contrato:

`Kairoseth Platform real -> enrollment -> sesión runtime -> WooCommerce controlado -> READ -> WRITE aprobado -> auditoría -> observabilidad -> reinicio seguro`.

7.2 entrega el **runner y el procedimiento**. La primera ejecución contra un **artefacto estable publicado** es 7.3.

### Límites de seguridad

- los secretos se leen únicamente desde archivos locales;
- no se aceptan `KAB_ACCEPTANCE_OPERATOR_TOKEN`, `KAB_ACCEPTANCE_WC_CONSUMER_KEY` ni `KAB_ACCEPTANCE_WC_CONSUMER_SECRET` con valores directos;
- en Unix los archivos de secretos deben tener permisos `0600`;
- Platform requiere HTTPS salvo opt-in explícito para un entorno controlado;
- WooCommerce requiere HTTPS siempre;
- el origen WooCommerce queda allowlisted exactamente;
- redes privadas WooCommerce están bloqueadas salvo opt-in explícito;
- el pedido debe estar en el estado previo esperado antes de permitir el WRITE;
- estado previo y estado objetivo deben ser distintos y pertenecer a la allowlist oficial del conector;
- la evidencia no conserva ID de pedido, respuestas WooCommerce ni secretos;
- al terminar se escanea el estado durable y se rechaza la aceptación si aparecen operator token, consumer key/secret, `approvalToken`, `accessToken` o un token `kab1` persistido.

### Variables no secretas

```bash
export KAB_PLATFORM_BASE_URL='https://kairoseth.com/'
export KAB_STATE_DIR='/var/lib/agent-bridge-phase7'
export KAB_ACCEPTANCE_RUNTIME_VERSION='0.1.0'
export KAB_ACCEPTANCE_ARTIFACT_SHA256='sha256:<64-hex>'

export KAB_ACCEPTANCE_WC_BASE_URL='https://woocommerce-controlado.example/'
export KAB_ACCEPTANCE_WC_ORDER_ID='1234'
export KAB_ACCEPTANCE_WC_EXPECTED_STATUS='processing'
export KAB_ACCEPTANCE_WC_TARGET_STATUS='completed'

export KAB_ACCEPTANCE_EVIDENCE_PATH='./artifacts/phase7-real-platform.json'
```

`KAB_ACCEPTANCE_ARTIFACT_SHA256` es opcional para validar el runner durante desarrollo, pero es **obligatorio operativamente en 7.3** para ligar la evidencia al artefacto estable exacto.

Opciones controladas:

```bash
# Solo si Platform usa HTTP dentro de un entorno controlado/local.
export KAB_ACCEPTANCE_ALLOW_INSECURE_PLATFORM_HTTP='true'

# Solo si el WooCommerce controlado vive en RFC1918/ULA/on-prem.
export KAB_ACCEPTANCE_ALLOW_PRIVATE_WC_NETWORK='true'

# 90 s por defecto; rango permitido 10 s–10 min.
export KAB_ACCEPTANCE_TIMEOUT_MS='90000'
```

### Secretos por archivo

```bash
install -m 600 /dev/null /run/secrets/kab-platform-operator-token
install -m 600 /dev/null /run/secrets/kab-wc-consumer-key
install -m 600 /dev/null /run/secrets/kab-wc-consumer-secret

# Escribir los valores mediante el secret manager/procedimiento operativo,
# no copiarlos al repositorio ni al historial del shell.

export KAB_ACCEPTANCE_OPERATOR_TOKEN_FILE='/run/secrets/kab-platform-operator-token'
export KAB_ACCEPTANCE_WC_CONSUMER_KEY_FILE='/run/secrets/kab-wc-consumer-key'
export KAB_ACCEPTANCE_WC_CONSUMER_SECRET_FILE='/run/secrets/kab-wc-consumer-secret'
```

El operator token debe pertenecer al workspace que se quiere aceptar y tener `agent-bridge / workspace.manage`.

### Ejecución

Desde el artefacto/runtime ya construido:

```bash
npm run acceptance:phase7-platform
```

El runner:

1. resuelve el workspace activo del operador;
2. solicita un enrollment token de un solo uso;
3. crea/persiste la identidad del Bridge y hace enrollment;
4. levanta `ProductionRuntime` con el conector WooCommerce oficial;
5. espera hasta que Platform muestre la instalación conectada con observabilidad;
6. ejecuta `woocommerce.store.orders.get` sobre el pedido controlado;
7. aborta antes de mutar si el estado real no coincide exactamente con `KAB_ACCEPTANCE_WC_EXPECTED_STATUS`;
8. solicita un `orders.update-status` mediante el endpoint de WRITE aprobado de Platform;
9. exige ACK `executed` y `deliveryAttempt=1`;
10. espera a que el outbox de auditoría local quede drenado;
11. detiene el runtime y lo crea de nuevo sobre el mismo `KAB_STATE_DIR`;
12. exige identidad y `InstallationBinding` idénticos;
13. vuelve a exigir conectividad/observabilidad en Platform;
14. verifica que los comandos ya completados siguen completados y con `deliveryAttempt=1`;
15. escanea el estado durable para detectar credenciales/tokens persistidos;
16. emite evidencia JSON sanitizada a stdout y, si se configuró, al fichero de evidencia con modo `0600`.

### Qué prueba el reinicio real y qué no se falsea

Kairoseth Platform **no reentrega comandos ya completados**. Esa es la semántica de producción correcta; por tanto, el runner real no introduce un endpoint especial para volver a reproducir un comando completado.

La seguridad ante la ventana `efecto ejecutado -> caída antes del ACK -> reentrega` se mantiene cubierta por la aceptación automatizada versionada:

`tests/acceptance/phase7-woocommerce-real-flow.test.ts`

Ese test conserva el mismo directorio durable, reentrega los mismos command IDs después del reinicio, exige ACK `duplicate` con `originalOutcome=executed` y comprueba que WooCommerce no recibe una segunda mutación.

La evidencia de 7.2/7.3 declara ambos límites de forma separada:

- real Platform: `completed_commands_not_redelivered`;
- crash/redelivery: aceptación automatizada de receipts persistidos.

No se añade una API de replay de comandos completados porque ampliaría innecesariamente la superficie de producción.

### Evidencia retenida

La evidencia incluye únicamente:

- versión del runtime;
- SHA-256 del artefacto, cuando se proporciona;
- origen de Platform;
- installation ID y bridge instance ID;
- command IDs y correlation IDs;
- estados/attempts del READ y WRITE;
- resultado del reinicio;
- resumen de observabilidad sin payloads de negocio;
- resultado de auditoría y secret scan;
- fuentes de errores recuperables observadas.

No incluye:

- operator token;
- consumer key/secret;
- enrollment/session/approval tokens;
- ID del pedido;
- cuerpo del pedido ni salida completa de WooCommerce.

### Condición de salida 7.2

7.2 queda cerrada cuando:

- el runner está versionado;
- sus tests negativos/positivos están verdes;
- CI principal permanece verde;
- la documentación ES/EN define el procedimiento sin secretos de repositorio.

La ejecución con el release estable y una instalación WooCommerce controlada cerrará 7.3.

---

## EN

### Objective

Reproducibly exercise:

`real Kairoseth Platform -> enrollment -> runtime session -> controlled WooCommerce -> READ -> approved WRITE -> audit -> observability -> safe restart`.

7.2 delivers the **runner and procedure**. The first execution against a **published stable artifact** is Phase 7.3.

### Security boundaries

- secrets are read only from local files;
- direct secret environment values are rejected;
- Unix secret files must be `0600`;
- Platform uses HTTPS unless a controlled-environment opt-in is explicit;
- WooCommerce always uses HTTPS;
- the exact WooCommerce origin is allowlisted;
- private WooCommerce networks require an explicit opt-in;
- the controlled order must match the expected pre-mutation status before WRITE is allowed;
- retained evidence excludes the order ID, WooCommerce bodies and credentials;
- durable state is scanned for operator/connector secrets, approval tokens and access-token fields before the run can pass.

### Execution

Configure the same non-secret and secret-file variables shown above and run:

```bash
npm run acceptance:phase7-platform
```

The runner obtains a one-time enrollment token from Platform, starts the real `ProductionRuntime`, performs the controlled READ and approved WRITE, waits for audit delivery, restarts over the same durable state, proves identity/binding stability and verifies completed commands were not re-delivered.

Production Platform intentionally does not replay already completed commands. Crash-window redelivery (`effect -> crash before ACK -> same command again`) remains proven by `tests/acceptance/phase7-woocommerce-real-flow.test.ts`, which requires durable `duplicate` receipts and zero repeated WooCommerce side effects. The real runner does not create a production replay backdoor merely for acceptance.

### 7.2 exit condition

7.2 is complete when the runner, tests and ES/EN operating procedure are merged with CI green. Phase 7.3 then runs this exact contract against the published stable artifact and the first controlled WooCommerce installation.

# Connector Circuit Breakers / Circuit breakers de conectores

## ES

### Objetivo

El circuit breaker evita que un backend degradado reciba llamadas de forma continua y aísla el fallo en la unidad más pequeña útil:

`connector + instance + tool`

Por ejemplo, un fallo repetido en `woocommerce.shop-a.orders.list` no debe bloquear `woocommerce.shop-a.products.list`, otro WooCommerce de otro cliente, MySQL, Files ni el resto de Kairoseth Agent Bridge.

### Estados

Cada circuito tiene tres estados:

- `closed`: las llamadas al backend están permitidas;
- `open`: las llamadas fallan rápido sin tocar el backend;
- `half-open`: después del cooldown se permite una única llamada de prueba.

Si la sonda `half-open` funciona, el circuito vuelve a `closed`. Si falla de forma transitoria, vuelve a `open` y comienza otro cooldown.

### Qué fallos cuentan

El breaker registra únicamente fallos que representan indisponibilidad/transitoriedad del backend:

- `ConnectorTransientError`;
- `ConnectorTimeoutError`, que deriva del error transitorio.

Errores de validación, configuración o negocio no cuentan como fallo de disponibilidad. Una respuesta válida del backend que rechaza una operación no significa que el backend esté caído.

### Interacción con retries

Los retries declarados por Connector SDK ocurren **dentro de una invocación**.

El circuit breaker registra un único fallo cuando esa invocación termina finalmente en error transitorio después de agotar sus retries permitidos. No cuenta cada intento interno como una caída independiente.

Flujo:

`breaker.beforeRequest -> retry loop -> final success/failure -> breaker.recordSuccess/recordFailure`

De esta forma un tool con tres retries no abre un breaker configurado a tres fallos por una sola invocación.

### Fail-fast

Cuando el circuito está `open`, la petición produce `ConnectorCircuitOpenError` antes de ejecutar la tool del conector.

Esto reduce:

- presión sobre sistemas ya degradados;
- consumo de conexiones y timeouts;
- cascadas de latencia;
- ruido en logs y monitorización.

El error del circuito no es un `ConnectorTransientError` para impedir que el retry loop interno vuelva a golpear inmediatamente un backend que el breaker acaba de proteger.

### Half-open y concurrencia

Después de `resetTimeoutMs`, la primera petición reserva la única sonda `half-open`.

Mientras esa sonda está en curso, cualquier otra petición al mismo circuito falla rápido. Esto evita una estampida de tráfico cuando termina el cooldown.

### Configuración

Defaults actuales:

- `failureThreshold`: 5 fallos finales consecutivos;
- `resetTimeoutMs`: 30 segundos.

Los deployments pueden proporcionar un `ConnectorCircuitBreaker` configurado al construir `ConnectorRegistryAdapter`.

Puede desactivarse con `circuitBreaker: false` únicamente cuando una capa exterior ya proporciona aislamiento equivalente. En producción normal, mantenerlo habilitado.

### Scope

El baseline guarda estado en memoria del proceso. Esto es apropiado para:

- runtime local único;
- sidecar único;
- Docker con una sola réplica;
- aislamiento por proceso incluso en deployments mayores.

Un futuro shared breaker puede respaldarse por almacenamiento distribuido si necesitamos que varias réplicas compartan exactamente el mismo estado de circuito. No es necesario para la garantía actual de idempotencia/seguridad: el breaker protege disponibilidad, no autoriza acciones.

### Boundary de seguridad

El circuit breaker no sustituye:

- identity;
- delegation;
- policy;
- approval;
- idempotency/replay protection;
- connector health checks;
- rate limits.

Una WRITE cuyo circuito está cerrado sigue necesitando approval. Un circuito abierto tampoco cambia ninguna autorización: simplemente evita una llamada a un backend temporalmente degradado.

### Observabilidad y health

El estado del breaker (`closed/open/half-open`, fallos consecutivos, retryAt) es información operacional segura y puede exponerse a la siguiente capa de health/observability.

No incluir payloads, credenciales ni secretos en snapshots de circuitos.

## EN

### Purpose

The circuit breaker prevents continuous calls to a degraded backend and isolates failure at the smallest useful unit:

`connector + instance + tool`

For example, repeated failure of `woocommerce.shop-a.orders.list` must not block `woocommerce.shop-a.products.list`, another customer's WooCommerce instance, MySQL, Files, or the rest of Kairoseth Agent Bridge.

### States

Each circuit has three states:

- `closed`: backend calls are allowed;
- `open`: calls fail fast without touching the backend;
- `half-open`: after cooldown, one probe request is allowed.

A successful `half-open` probe closes the circuit. A transient probe failure reopens it and starts another cooldown.

### Which failures count

The breaker records only failures representing backend availability/transience:

- `ConnectorTransientError`;
- `ConnectorTimeoutError`, which derives from the transient error type.

Validation, configuration and business errors do not count as availability failures. A valid backend response rejecting an operation does not mean the backend is unavailable.

### Interaction with retries

Connector SDK retries happen **inside one invocation**.

The circuit breaker records one failure only when that invocation finally ends in a transient error after exhausting its allowed retries. Individual retry attempts do not count as independent outages.

Flow:

`breaker.beforeRequest -> retry loop -> final success/failure -> breaker.recordSuccess/recordFailure`

Therefore, a tool configured with three retries does not open a threshold-three breaker because of one invocation.

### Fail-fast

While the circuit is `open`, the request raises `ConnectorCircuitOpenError` before connector tool execution.

This reduces:

- load on already degraded systems;
- wasted connections and timeouts;
- latency cascades;
- log and monitoring noise.

The circuit-open error is deliberately not a `ConnectorTransientError`, preventing the internal retry loop from immediately hammering a backend the breaker just protected.

### Half-open and concurrency

After `resetTimeoutMs`, the first request reserves the single `half-open` probe.

While that probe is in flight, other requests to the same circuit fail fast. This avoids a traffic stampede when cooldown ends.

### Configuration

Current defaults:

- `failureThreshold`: 5 final consecutive failures;
- `resetTimeoutMs`: 30 seconds.

Deployments may provide a configured `ConnectorCircuitBreaker` when constructing `ConnectorRegistryAdapter`.

It may be disabled with `circuitBreaker: false` only when an outer layer already provides equivalent isolation. Normal production deployments should keep it enabled.

### Scope

The baseline keeps circuit state in process memory. This is appropriate for:

- a single local runtime;
- a single sidecar;
- single-replica Docker;
- per-process isolation in larger deployments.

A future shared breaker may use distributed state if multiple replicas need an identical circuit view. This is not required for current idempotency/security guarantees: a breaker protects availability and never authorizes actions.

### Security boundary

The circuit breaker does not replace:

- identity;
- delegation;
- policy;
- approval;
- idempotency/replay protection;
- connector health checks;
- rate limits.

A WRITE with a closed circuit still requires approval. An open circuit also changes no authorization decision; it only prevents a call to a temporarily degraded backend.

### Observability and health

Breaker state (`closed/open/half-open`, consecutive failures and retryAt) is safe operational metadata that can feed the next health/observability layer.

Circuit snapshots must never contain payloads, credentials or secrets.

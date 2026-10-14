# Kairoseth Agent Bridge — Connector Health Isolation

## ES — Español

### Objetivo

La capa de health isolation permite observar el estado operativo de cada instancia de conector sin convertir un fallo local en un fallo global del Agent Bridge.

Una instalación puede tener simultáneamente WooCommerce, PrestaShop, MySQL, Files, APIs REST y conectores propios. Si una instancia o una tool se degrada, las demás deben seguir siendo visibles y operativas según su propia policy.

### Modelo

`ConnectorRegistryAdapter` mantiene las instancias que registra y expone tres niveles:

- `health(instance)` — ejecuta el probe declarado por un conector;
- `healthSnapshot(instance)` — combina el probe con el estado de circuit breaker de sus tools;
- `healthRegistered()` — obtiene snapshots de todas las instancias registradas en orden determinista.

Los estados de instancia son:

- `healthy` — probe sano y tools disponibles;
- `degraded` — el probe está degradado o alguna tool está degradada/bloqueada mientras otras siguen disponibles;
- `unhealthy` — el probe está unhealthy o todas las tools de la instancia están bloqueadas.

Los estados de disponibilidad por tool son:

- `available` — circuito cerrado y sin fallos pendientes;
- `degraded` — circuito half-open, probe de recuperación en curso o fallos consecutivos todavía por debajo del umbral;
- `blocked` — circuito abierto.

### Aislamiento de probes

Cada health probe tiene un timeout duro del runtime.

El Bridge usa `Promise.race`, por lo que un conector que ignore accidentalmente su `AbortSignal` no puede bloquear indefinidamente la recolección de health.

Si el probe:

- supera el timeout, se normaliza a `unhealthy` con `details.probe = "timeout"`;
- lanza una excepción, se normaliza a `unhealthy` con `details.probe = "failed"`;
- no existe, se usa el baseline `healthy` con `details.probe = "not_declared"`.

Los mensajes raw de excepciones no se copian al snapshot. Esto evita que un error construido por un SDK remoto filtre accidentalmente tokens, passwords o payloads sensibles en observabilidad.

### Aislamiento entre instancias

`healthRegistered()` ejecuta los probes de las instancias de forma independiente.

Un timeout o excepción de `woocommerce.shop-a` no rechaza la colección ni oculta el estado de `prestashop.shop-b`, `mysql.erp` o cualquier otra instancia.

El orden del resultado es determinista por `connectorId + connectorInstanceId`, lo que facilita diff, cache y renderizado en Kairoseth Platform.

### Integración con circuit breakers

Health no duplica ni sustituye al circuit breaker.

El circuit breaker sigue siendo el mecanismo que evita llamadas repetidas a una tool cuyo backend está fallando. Health únicamente proyecta ese estado en un snapshot operativo por instancia.

Ejemplo:

```text
WooCommerce / tienda-bcn
  probe: healthy
  orders.list: blocked
  products.list: available
  instance: degraded

PrestaShop / tienda-madrid
  probe: healthy
  tools: available
  instance: healthy
```

Un circuito abierto de una tool no abre los circuitos de otras tools ni de otras instancias.

### Boundary de seguridad

Health es observabilidad, no autorización.

Un snapshot `healthy`:

- no concede permisos;
- no evita policy;
- no evita signed approval;
- no cambia READ / WRITE / CRITICAL;
- no habilita una tool deshabilitada por otros controles.

Un snapshot `unhealthy` tampoco debe utilizarse como sustituto de la policy de seguridad. La ejecución continúa gobernada por `BridgeRuntime`, policy, approval, idempotency y circuit breaker.

### ES/EN

Los estados y códigos técnicos (`healthy`, `degraded`, `unhealthy`, `available`, `blocked`, `timeout`, etc.) son estables e independientes del idioma.

Kairoseth Platform debe traducir estos códigos a copy ES/EN en sus superficies de operador. Los snapshots no dependen del locale y no utilizan el idioma como señal de identidad, tenant o autorización.

---

## EN — English

### Goal

The health-isolation layer observes each connector instance independently so a local backend failure does not become a global Agent Bridge failure.

A deployment can run WooCommerce, PrestaShop, MySQL, Files, REST APIs and custom connectors at the same time. If one instance or tool degrades, the remaining instances must stay visible and operational according to their own policy.

### Model

`ConnectorRegistryAdapter` tracks the connector instances it registers and exposes three levels:

- `health(instance)` — runs the connector-declared probe;
- `healthSnapshot(instance)` — combines that probe with per-tool circuit-breaker state;
- `healthRegistered()` — returns deterministic snapshots for all registered instances.

Instance states are:

- `healthy` — healthy probe and available tools;
- `degraded` — the probe is degraded or one/more tools are degraded/blocked while other tools remain available;
- `unhealthy` — the connector probe is unhealthy or every tool in the instance is blocked.

Per-tool availability states are:

- `available` — closed circuit with no pending availability failures;
- `degraded` — half-open circuit, recovery probe in flight, or consecutive failures below the opening threshold;
- `blocked` — open circuit.

### Probe isolation

Every connector health probe has a hard runtime timeout.

The Bridge uses `Promise.race`, so a defective connector that ignores its `AbortSignal` cannot block health collection indefinitely.

When a probe:

- exceeds the timeout, it is normalized to `unhealthy` with `details.probe = "timeout"`;
- throws, it is normalized to `unhealthy` with `details.probe = "failed"`;
- is not declared, the Bridge reports the baseline `healthy` result with `details.probe = "not_declared"`.

Raw exception messages are not copied into the operational snapshot. This prevents a remote SDK error from accidentally leaking tokens, passwords or sensitive payload data into observability.

### Instance isolation

`healthRegistered()` probes registered instances independently.

A timeout or exception from `woocommerce.shop-a` cannot reject the collection or hide the status of `prestashop.shop-b`, `mysql.erp` or another instance.

Results are ordered deterministically by `connectorId + connectorInstanceId`, which makes them suitable for diffing, caching and Kairoseth Platform rendering.

### Circuit-breaker integration

Health does not replace or duplicate the circuit breaker.

The circuit breaker remains the availability control that prevents repeated calls to a failing tool backend. Health only projects that state into an operational instance snapshot.

Example:

```text
WooCommerce / shop-bcn
  probe: healthy
  orders.list: blocked
  products.list: available
  instance: degraded

PrestaShop / shop-madrid
  probe: healthy
  tools: available
  instance: healthy
```

An open circuit for one tool does not open circuits for other tools or other connector instances.

### Security boundary

Health is observability, not authorization.

A `healthy` snapshot:

- does not grant permissions;
- does not bypass policy;
- does not bypass signed approval;
- does not change READ / WRITE / CRITICAL;
- does not enable a tool disabled by another control.

Likewise, `unhealthy` is not a replacement security policy. Execution remains governed by `BridgeRuntime`, policy, approval, idempotency and the circuit breaker.

### ES/EN

Technical states and codes (`healthy`, `degraded`, `unhealthy`, `available`, `blocked`, `timeout`, and related values) are stable and locale-independent.

Kairoseth Platform should translate these codes into ES/EN operator copy. Health snapshots do not depend on locale and locale is never used as an identity, tenant or authorization signal.

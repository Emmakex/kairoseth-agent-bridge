# Admission Limits / Límites de admisión

## ES

### Objetivo

`AdmissionControlPolicyEvaluator` aplica controles de tamaño y frecuencia **antes** de la policy de autorización normal. No concede permisos: una petición que supera admisión todavía debe pasar por delegation, policy y approval cuando corresponda.

Flujo conceptual:

`input -> payload bound -> rate rules -> authorization policy -> approval -> execution`

### Límite de payload

El input se serializa mediante JSON canónico y se mide en bytes UTF-8.

- límite por defecto: 1 MiB;
- máximo configurable por el core: 16 MiB;
- pueden declararse overrides exactos por `toolId` cuando una herramienta necesita legítimamente un límite distinto;
- un input no representable como JSON canónico se deniega.

Los límites específicos de conectores/protocolos siguen siendo válidos y pueden ser más estrictos. El límite de admisión no debe usarse para ampliar un límite más pequeño impuesto por un conector.

### RateLimitStore

`RateLimitStore.consume()` representa una operación **atómica test-and-increment** dentro de una ventana fija.

Una implementación compartida/clustered debe realizar esa operación en el backend autoritativo. No es seguro hacer un GET y luego un UPDATE/INSERT independientes.

Opciones típicas:

- Redis con Lua/transaction/operación atómica;
- MongoDB con update condicional/atómico e índices adecuados;
- SQL con transacción/upsert/row lock o primitivas equivalentes.

`InMemoryFixedWindowRateLimitStore` es baseline para tests y runtime de un solo proceso.

### Scopes disponibles

Las reglas pueden limitar por:

- `tenant`;
- `installation`;
- `actor`;
- `tool`;
- `actor-tool`;
- `installation-tool`.

También pueden aplicarse únicamente a determinados riesgos `READ`, `WRITE` o `CRITICAL`.

Los scopes provienen del `InvocationContext` confiable. Si una regla necesita tenant/installation/actor y ese dato no está disponible, la invocación se deniega.

Las keys almacenadas en el rate backend contienen el ID de regla y un SHA-256 del scope, evitando exponer directamente nombres de actores, tenants o installations en las claves operativas.

### Backend no disponible

Por defecto la admisión falla cerrada.

Puede activarse explícitamente `failOpenForReadOnRateLimitError` cuando un deployment acepte priorizar disponibilidad para READ. Esta opción **nunca** abre WRITE ni CRITICAL: las mutaciones permanecen fail-closed si el rate backend está caído.

### Interacción con approvals

Consumir cuota no equivale a estar autorizado.

Ejemplo:

1. una WRITE entra dentro del límite de frecuencia;
2. admisión permite continuar;
3. `SecureDefaultPolicyEvaluator` devuelve `REQUIRE_APPROVAL`;
4. no existe side effect hasta recibir y validar el approval correspondiente.

Las peticiones que terminan en DENY o REQUIRE_APPROVAL pueden consumir cuota porque el rate limiter protege intentos, no solo ejecuciones exitosas.

### Configuración recomendada

Combinar reglas amplias y específicas, por ejemplo:

- cuota por installation para proteger el runtime;
- cuota por actor para limitar agentes ruidosos;
- cuota `actor-tool` para endpoints costosos;
- reglas más bajas para WRITE/CRITICAL.

Los valores concretos deben venir del control plane/deployment profile y ajustarse al producto/conector. No hardcodear una misma cuota comercial para todos los clientes dentro del core.

## EN

### Purpose

`AdmissionControlPolicyEvaluator` applies size and frequency controls **before** the normal authorization policy. It does not grant access: an admitted request still has to pass delegation, policy and approval when applicable.

Conceptual flow:

`input -> payload bound -> rate rules -> authorization policy -> approval -> execution`

### Payload bound

Input is encoded as canonical JSON and measured as UTF-8 bytes.

- default limit: 1 MiB;
- maximum configurable core limit: 16 MiB;
- exact per-`toolId` overrides may be declared when a tool legitimately needs a different bound;
- input that cannot be represented as canonical JSON is denied.

Connector/protocol-specific bounds still apply and may be stricter. Admission limits must not be used to bypass a smaller connector-specific bound.

### RateLimitStore

`RateLimitStore.consume()` represents an **atomic test-and-increment** operation for one fixed window.

A shared/clustered implementation must perform this operation in the authoritative backend. A separate GET followed by UPDATE/INSERT is unsafe.

Typical implementations include:

- Redis using Lua/transactions/atomic primitives;
- MongoDB using atomic conditional updates and appropriate indexes;
- SQL using transactions/upserts/row locks or equivalent primitives.

`InMemoryFixedWindowRateLimitStore` is the baseline for tests and single-process runtimes.

### Available scopes

Rules may apply per:

- `tenant`;
- `installation`;
- `actor`;
- `tool`;
- `actor-tool`;
- `installation-tool`.

They may also target only selected `READ`, `WRITE` or `CRITICAL` risks.

Scopes come from trusted `InvocationContext` data. If a rule requires tenant/installation/actor and that trusted scope is unavailable, admission is denied.

Stored rate-limit keys contain the rule ID plus a SHA-256 digest of the scope, avoiding direct actor, tenant or installation identifiers in operational keys.

### Backend unavailable

Admission is fail-closed by default.

A deployment may explicitly enable `failOpenForReadOnRateLimitError` when READ availability is preferred. This option **never** opens WRITE or CRITICAL paths: mutations remain fail-closed when the rate backend is unavailable.

### Interaction with approvals

Consuming quota is not authorization.

Example:

1. a WRITE is within its rate quota;
2. admission allows processing to continue;
3. `SecureDefaultPolicyEvaluator` returns `REQUIRE_APPROVAL`;
4. no side effect occurs until the corresponding approval is received and verified.

Requests ending in DENY or REQUIRE_APPROVAL may consume quota because the limiter protects attempts, not only successful executions.

### Recommended configuration

Combine broad and specific rules, for example:

- installation quota to protect the runtime;
- actor quota for noisy agents;
- `actor-tool` quota for expensive operations;
- lower limits for WRITE/CRITICAL.

Concrete values should come from the control-plane/deployment profile and match the product/connector. Do not hardcode one commercial quota for every customer inside the core.

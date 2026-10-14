# Kairoseth Agent Bridge — Official A2A SDK Interoperability

## ES

### Baseline validado

Kairoseth Agent Bridge valida interoperabilidad A2A v1 mediante el SDK oficial JavaScript/TypeScript:

- paquete: `@a2a-js/sdk`;
- versión fijada en tests: `1.3.0`;
- protocolo: A2A v1.0;
- binding validado: `JSONRPC`;
- cliente oficial: `Client`;
- transporte oficial: `JsonRpcTransportFactory`;
- compatibilidad legacy v0.3: desactivada por defecto.

El SDK se mantiene como `devDependency`. No forma parte del core de ejecución de Kairoseth: sirve como prueba externa de que nuestras superficies A2A son consumibles por una implementación oficial del protocolo.

### Qué valida la aceptación

La aceptación de Phase 5 comprueba que:

1. El `AgentCard` generado por `A2AAgentCardAdapter` puede ser parseado por `AgentCard.fromJSON()` del SDK oficial.
2. El SDK serializa un `SendMessageRequest` A2A v1 válido.
3. `JsonRpcTransportFactory` envía `SendMessage` mediante JSON-RPC 2.0.
4. El cliente envía `A2A-Version: 1.0`.
5. La extensión estructurada de Kairoseth se activa mediante `A2A-Extensions`.
6. El request entra por `A2AIdentityMapper`, no por identidad autoafirmada en el mensaje.
7. La ejecución continúa por `A2AToolExecutionAdapter -> BridgeRuntime`.
8. Una tool READ termina en `TASK_STATE_COMPLETED` con un Artifact JSON que el SDK oficial deserializa correctamente.
9. Una tool WRITE termina en `TASK_STATE_AUTH_REQUIRED` bajo la política segura por defecto y no produce side effects.
10. El SDK oficial puede recuperar esa misma tarea mediante `GetTask` y conserva el estado `TASK_STATE_AUTH_REQUIRED`.
11. Audit y provenance siguen siendo contratos comunes de Kairoseth.

### Boundary de seguridad

El SDK oficial no decide autorización.

La secuencia de confianza sigue siendo:

`transporte autenticado -> identity mapping Kairoseth -> delegación -> policy -> approval -> ejecución -> audit`

`AgentCard`, skills, annotations, extension metadata y hints del SDK son información descriptiva o de negociación; nunca reemplazan policy o approvals.

### Compatibilidad v0.3

El SDK oficial ofrece compatibilidad v0.3 mediante opt-in. Agent Bridge no la activa por defecto.

La línea base de Kairoseth es A2A v1.0. Si una instalación necesitara interoperar temporalmente con peers v0.3, esa capacidad deberá habilitarse explícitamente por transporte y añadirse a la matriz de pruebas correspondiente.

### Siguientes transportes

La aceptación de Phase 5 cierra con JSON-RPC porque prueba el contrato completo sin introducir un servidor HTTP o dependencias de framework en el core.

HTTP+JSON/REST y gRPC podrán añadirse como packaging/deployment adapters cuando exista una necesidad concreta. Deben reutilizar el mismo `A2AIdentityMapper`, `A2AToolExecutionAdapter`, `BridgeRuntime`, policy, approval, provenance y audit.

## EN

### Validated baseline

Kairoseth Agent Bridge validates A2A v1 interoperability against the official JavaScript/TypeScript SDK:

- package: `@a2a-js/sdk`;
- test-pinned version: `1.3.0`;
- protocol: A2A v1.0;
- validated binding: `JSONRPC`;
- official client: `Client`;
- official transport: `JsonRpcTransportFactory`;
- legacy v0.3 compatibility: disabled by default.

The SDK remains a `devDependency`. It is not part of Kairoseth's execution core; it acts as an external conformance/interoperability client proving that our A2A surfaces are consumable by an official protocol implementation.

### Acceptance coverage

The Phase 5 acceptance proves that the official SDK can parse our Agent Card, serialize v1 SendMessage requests, negotiate version and extension headers, invoke a READ through Kairoseth identity/policy/audit, deserialize a completed Task and JSON Artifact, receive `TASK_STATE_AUTH_REQUIRED` for a WRITE with zero side effects, and retrieve that task again through official `GetTask`.

### Security boundary

The official SDK is not an authorization authority.

The trust sequence remains:

`authenticated transport -> Kairoseth identity mapping -> delegation -> policy -> approval -> execution -> audit`

Agent Card data, skills, annotations, extension metadata, and SDK hints never replace Kairoseth policy or approvals.

### v0.3 compatibility

The official SDK provides opt-in v0.3 compatibility. Agent Bridge keeps it disabled by default. Kairoseth's baseline is A2A v1.0; any temporary legacy compatibility must be enabled explicitly per transport and covered by its own tests.

### Additional transports

Phase 5 closes on JSON-RPC because it validates the complete contract without coupling the core to an HTTP framework. HTTP+JSON/REST and gRPC can be added later as deployment adapters when required, while reusing the same identity, execution, policy, approval, provenance, and audit contracts.

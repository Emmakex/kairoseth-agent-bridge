# Kairoseth Agent Bridge — Invocation Provenance v1

## ES

### Objetivo

`kab.provenance.v1` permite reconstruir una cadena de invocaciones entre agentes y protocolos sin convertir el audit en un almacén de credenciales.

Cada invocación puede transportar una provenance segura con:

- `protocol`: protocolo que originó esa invocación (`a2a`, `mcp`, `kairoseth-native`, `rest`, `webhook` o `internal`);
- `rootCorrelationId`: correlación de la raíz de toda la cadena;
- `parentCorrelationId`: correlación de la invocación inmediatamente anterior, cuando existe;
- `principal`: identidad autenticada saneada (`issuer`, `subject`, método y `clientId` opcional).

El `correlationId` de la invocación actual permanece en `InvocationContext`. No se duplica dentro de provenance.

### Regla de seguridad

Provenance es trazabilidad, no autorización.

Nunca debe contener:

- bearer/API keys;
- approval tokens;
- delegation tokens;
- secretos;
- scopes OAuth completos;
- payloads de negocio.

Identity, delegation, approval y policy siguen siendo controles separados.

### Cadena agent-to-agent

Para una secuencia:

`Agente A -> Agente B -> tool`

un ejemplo de correlación sería:

- A: `correlationId = root-1`, `rootCorrelationId = root-1`;
- B: `correlationId = child-1`, `rootCorrelationId = root-1`, `parentCorrelationId = root-1`;
- siguiente hijo: `correlationId = child-2`, `rootCorrelationId = root-1`, `parentCorrelationId = child-1`.

`deriveChildInvocationProvenance()` conserva la raíz y enlaza siempre al padre inmediato.

### A2A

`A2AIdentityMapper` crea provenance únicamente a partir del principal ya verificado por el host y de lineage que el host trate como confiable.

El caller remoto no puede convertir `Message.metadata` en provenance confiable.

Cuando una tarea A2A queda en `TASK_STATE_AUTH_REQUIRED`, la provenance original se guarda junto con la invocación. En el resume, el Bridge conserva:

- `correlationId` original;
- action fingerprint original;
- provenance original.

Una nueva lineage aportada durante el resume no reemplaza la historia de la acción pendiente.

### Audit

`BridgeRuntime` adjunta provenance a todos los eventos de lifecycle cuando está disponible:

- `INVOCATION_RECEIVED`;
- `POLICY_EVALUATED`;
- `EXECUTION_STARTED`;
- `EXECUTION_SUCCEEDED`;
- `EXECUTION_FAILED`.

`SanitizedAuditSink` copia solo los campos permitidos a `kab.audit-event.v1`. Los IDs se normalizan y limitan; tokens y scopes no forman parte del contrato de provenance.

Esto permite a Kairoseth Platform reconstruir cadenas cross-agent usando `rootCorrelationId` y `parentCorrelationId` sin acceder a credenciales.

## EN

### Goal

`kab.provenance.v1` makes agent-to-agent and cross-protocol invocation chains reconstructable without turning audit into a credential store.

Each invocation may carry safe provenance containing:

- `protocol`: protocol that originated the invocation (`a2a`, `mcp`, `kairoseth-native`, `rest`, `webhook`, or `internal`);
- `rootCorrelationId`: correlation identifier for the root of the full chain;
- `parentCorrelationId`: immediately preceding invocation correlation when one exists;
- `principal`: sanitized authenticated identity (`issuer`, `subject`, authentication method, and optional `clientId`).

The current invocation `correlationId` remains on `InvocationContext`; it is not duplicated inside provenance.

### Security rule

Provenance is traceability, not authorization.

It must never contain bearer/API keys, approval tokens, delegation tokens, secrets, full OAuth scopes, or business payloads.

Identity, delegation, approval, and policy remain separate controls.

### Agent-to-agent chain

For `Agent A -> Agent B -> tool`, children preserve the original `rootCorrelationId` while setting `parentCorrelationId` to the immediate parent invocation. `deriveChildInvocationProvenance()` implements that rule.

### A2A

`A2AIdentityMapper` creates provenance only from a host-verified principal and lineage the trusted host accepts. Untrusted `Message.metadata` is never an authorization or provenance source.

If an A2A task pauses in `TASK_STATE_AUTH_REQUIRED`, its original correlation, action fingerprint, and provenance are stored together. Resuming the task cannot replace the pending action's lineage with a new one.

### Audit

`BridgeRuntime` propagates provenance through the normal audit lifecycle. `SanitizedAuditSink` persists only the allowlisted provenance fields in `kab.audit-event.v1`, enabling Kairoseth Platform to reconstruct cross-agent chains without storing credentials or authorization material.

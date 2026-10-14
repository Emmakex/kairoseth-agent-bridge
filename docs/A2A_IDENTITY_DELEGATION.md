# Kairoseth Agent Bridge — A2A Identity & Delegation v1

## ES

### Objetivo

La identidad y la delegación A2A se separan deliberadamente de la aprobación de acciones. El flujo de confianza es:

`transporte A2A autentica -> Kairoseth resuelve binding -> delegación limita alcance -> policy evalúa -> approval autoriza mutación concreta -> connector ejecuta`

Ningún paso sustituye al siguiente.

### 1. Principal A2A verificado

El host/transporte A2A valida el mecanismo publicado en el Agent Card, por ejemplo OAuth2, Bearer, mTLS, API key o un mecanismo custom controlado. Tras validar credenciales, entrega al Bridge únicamente evidencia normalizada y no secreta:

- `issuer`
- `subject`
- método de autenticación
- `clientId` opcional
- scopes opcionales

El Bridge no recibe ni publica el bearer token/API key original dentro de metadata de invocación.

### 2. Binding autoritativo de Kairoseth

El principal de transporte **no contiene autoridad para elegir tenant o instalación**.

`A2AIdentityMapper` llama a un `A2APrincipalBindingResolver`. Ese resolver representa la integración con Kairoseth Platform/control plane y devuelve:

- `actor`
- `tenantId`
- `installationId`
- si esa identidad exige delegación firmada

Si no existe binding, el binding es inválido o el resolver falla, el mapping falla de forma cerrada.

La implementación de la base de datos de bindings pertenece a Kairoseth Platform, no a Agent Bridge.

### 3. Delegación firmada

Una identidad puede requerir un grant firmado por Kairoseth para actuar en nombre de otro actor o dentro de un alcance limitado.

Formato del token:

`kabd1.<key-id>.<payload>.<signature>`

Payload `kab.agent-delegation.v1`:

```json
{
  "version": "kab.agent-delegation.v1",
  "audience": "kairoseth-agent-bridge",
  "delegationId": "...",
  "tenantId": "...",
  "installationId": "...",
  "delegatorActor": "...",
  "delegateActor": "...",
  "toolIds": ["..."],
  "maxRisk": "READ | WRITE | CRITICAL",
  "issuedAt": "...",
  "expiresAt": "..."
}
```

La firma usa Ed25519. La verificación exige:

- tenant e instalación exactos;
- actor delegado exacto;
- tool incluida en allowlist;
- riesgo de la tool no superior a `maxRisk`;
- ventana temporal válida;
- vida máxima configurada;
- clave de firma confiable;
- estado no revocado cuando se configura un comprobador de revocación.

Los errores de lookup de clave o revocación se tratan fail-closed.

### 4. Delegación no es aprobación

Una delegación responde a:

> “¿Puede este agente solicitar esta tool dentro de este alcance?”

Una aprobación responde a:

> “¿Puede ejecutarse esta acción mutante concreta, con este input exacto, ahora?”

Por eso `DelegationPolicyEvaluator` verifica primero la delegación y después ejecuta la policy original. Una delegación que permite una tool WRITE **sigue produciendo `REQUIRE_APPROVAL`** bajo la secure-default policy hasta existir la aprobación específica de Kairoseth.

### 5. Metadata y secretos

`delegationToken` y `approvalToken` son campos confiables separados de `InvocationContext.metadata`.

La metadata A2A puede conservar provenance no secreto como issuer, subject, método, clientId y scopes, pero nunca debe contener tokens, claves o credenciales brutas.

### 6. Responsabilidades

**Kairoseth Platform / control plane**

- administra bindings de principals;
- decide qué identidades requieren delegación;
- firma grants de delegación;
- mantiene claves confiables/rotación;
- opcionalmente mantiene revocaciones;
- emite approvals de acciones mutantes.

**Kairoseth Agent Bridge**

- consume bindings mediante contrato;
- verifica grants;
- compone delegación con policy/approval;
- ejecuta tools solo mediante `BridgeRuntime`;
- preserva audit/provenance sin filtrar secretos.

---

## EN

### Goal

A2A identity and delegation are deliberately separate from action approval. The trust flow is:

`A2A transport authenticates -> Kairoseth resolves binding -> delegation limits scope -> policy evaluates -> approval authorizes exact mutation -> connector executes`

No step replaces the next one.

### 1. Verified A2A principal

The A2A host/transport validates the security mechanism published in the Agent Card, such as OAuth2, Bearer, mTLS, API key or a controlled custom mechanism. After credential verification it gives the Bridge only normalized, non-secret evidence:

- `issuer`
- `subject`
- authentication method
- optional `clientId`
- optional scopes

The Bridge does not place the original bearer token/API key into invocation metadata.

### 2. Authoritative Kairoseth binding

The transport principal **has no authority to choose a tenant or installation**.

`A2AIdentityMapper` calls an `A2APrincipalBindingResolver`. That resolver represents the Kairoseth Platform/control-plane integration and returns:

- `actor`
- `tenantId`
- `installationId`
- whether the identity requires a signed delegation

Missing, invalid or unavailable binding resolution fails closed.

The binding database implementation belongs to Kairoseth Platform, not Agent Bridge.

### 3. Signed delegation

An identity may require a Kairoseth-signed grant before acting on behalf of another actor or within a limited scope.

Token format:

`kabd1.<key-id>.<payload>.<signature>`

`kab.agent-delegation.v1` payload:

```json
{
  "version": "kab.agent-delegation.v1",
  "audience": "kairoseth-agent-bridge",
  "delegationId": "...",
  "tenantId": "...",
  "installationId": "...",
  "delegatorActor": "...",
  "delegateActor": "...",
  "toolIds": ["..."],
  "maxRisk": "READ | WRITE | CRITICAL",
  "issuedAt": "...",
  "expiresAt": "..."
}
```

The token is Ed25519-signed. Verification requires:

- exact tenant and installation;
- exact delegated actor;
- tool present in the allowlist;
- tool risk no higher than `maxRisk`;
- valid time window;
- configured maximum lifetime;
- trusted signing key;
- non-revoked state when a revocation checker is configured.

Signing-key or revocation lookup failures are fail-closed.

### 4. Delegation is not approval

Delegation answers:

> “May this agent request this tool within this scope?”

Approval answers:

> “May this exact mutating action, with this exact input, execute now?”

`DelegationPolicyEvaluator` therefore verifies delegation first and then calls the original policy. A grant allowing a WRITE tool **still produces `REQUIRE_APPROVAL`** under the secure-default policy until a separate Kairoseth approval exists for the concrete action.

### 5. Metadata and secrets

`delegationToken` and `approvalToken` are trusted fields kept outside `InvocationContext.metadata`.

A2A metadata may preserve non-secret provenance such as issuer, subject, method, clientId and scopes, but must never contain raw tokens, keys or credentials.

### 6. Responsibilities

**Kairoseth Platform / control plane**

- manages principal bindings;
- decides which identities require delegation;
- signs delegation grants;
- manages trusted keys/rotation;
- optionally maintains revocations;
- issues approvals for mutating actions.

**Kairoseth Agent Bridge**

- consumes bindings through a contract;
- verifies grants;
- composes delegation with policy/approval;
- executes tools only through `BridgeRuntime`;
- preserves audit/provenance without leaking secrets.

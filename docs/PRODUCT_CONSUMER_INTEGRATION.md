# Product consumer integration contract v1 / Contrato de integración de consumidores de producto v1

Status / Estado: **baseline implemented in Kairoseth Platform**

This contract defines how a Kairoseth product such as IA Empleado consumes Agent Bridge capabilities without embedding the Agent Bridge runtime, downstream credentials or tenant-routing authority inside the product.

Este contrato define cómo un producto Kairoseth como IA Empleado consume capacidades de Agent Bridge sin incrustar el runtime de Agent Bridge, credenciales del sistema final ni autoridad de routing de tenant dentro del producto.

---

## 1. Architecture boundary / Límite de arquitectura

```text
Product consumer / Producto consumidor
          |
          | machine credential + tool intent
          v
Kairoseth Platform / control plane
          |
          | authoritative tenant + installation binding
          | policy / command / audit
          v
Agent Bridge runtime
          |
          v
Customer system / Sistema del cliente
```

**EN.** The product consumer never talks directly to WooCommerce, PrestaShop, ERP/CRM credentials, databases or other customer-system secrets through this contract. Kairoseth Platform remains the authority that binds the consumer to an allowed Agent Bridge installation.

**ES.** El producto consumidor nunca accede directamente mediante este contrato a credenciales de WooCommerce, PrestaShop, ERP/CRM, bases de datos u otros secretos del sistema del cliente. Kairoseth Platform continúa siendo la autoridad que vincula al consumidor con una instalación Agent Bridge permitida.

## 2. Machine identity / Identidad machine

The baseline Platform implementation uses a machine credential resolved by `AgentBridgeConsumerAuthProvider`.

Each credential is bound server-side to exactly:

- `consumerId`;
- `tenantId`;
- `installationId`;
- an explicit permission set.

Current v1 permissions are:

- `tools.read`;
- `commands.execute-read`;
- `commands.read`.

The caller **must not** supply or override `tenantId`, `organizationId` or `installationId`. Routing authority is derived exclusively from the authenticated binding.

La implementación base de Platform utiliza una credencial machine resuelta por `AgentBridgeConsumerAuthProvider`. Cada credencial queda vinculada server-side a `consumerId`, `tenantId`, `installationId` y permisos explícitos. El consumidor **no puede** enviar ni sustituir `tenantId`, `organizationId` o `installationId`; la autoridad de routing deriva exclusivamente del binding autenticado.

### Secret handling / Gestión del secreto

The raw bearer token belongs only on the consumer side. The current bootstrap/static Platform provider stores only the token SHA-256 digest and uses constant-time digest comparison. Raw tokens must not be committed to Git, included in API payloads, logs or evidence.

El bearer token en claro pertenece únicamente al lado consumidor. El provider bootstrap/static actual de Platform conserva solo el digest SHA-256 y compara en tiempo constante. Los tokens en claro no deben entrar en Git, payloads API, logs ni evidencia.

`KCC_AGENT_BRIDGE_CONSUMER_BINDINGS_JSON` is a bootstrap/reference configuration mechanism, not a customer-facing credential-management UX. A managed persistent credential lifecycle can replace the provider implementation later without changing the consumer route contract.

`KCC_AGENT_BRIDGE_CONSUMER_BINDINGS_JSON` es un mecanismo de configuración bootstrap/reference, no una UX de gestión de credenciales para clientes. Un ciclo de vida persistente y gestionado puede sustituir el provider posteriormente sin cambiar el contrato de rutas del consumidor.

## 3. Consumer API / API consumer

The v1 Platform surface is separate from the human/operator surface:

```text
GET  /v1/products/agent-bridge/consumer/tools
POST /v1/products/agent-bridge/consumer/commands
GET  /v1/products/agent-bridge/consumer/commands/:commandId
```

All responses are `cache-control: no-store` and use the existing sanitized command projection where applicable.

La superficie v1 de Platform está separada de la superficie humana/operador. Las respuestas usan `cache-control: no-store` y reutilizan la proyección saneada de comandos cuando corresponde.

### Tool discovery / Descubrimiento de tools

`GET /consumer/tools` resolves the authenticated tenant/installation binding and returns only the inventory published for that installation.

The consumer receives stable execution tool IDs, risk, availability, localized discovery metadata and connector identity. It does not receive tenant routing authority or downstream credentials.

`GET /consumer/tools` resuelve el binding autenticado tenant/instalación y devuelve únicamente el inventario publicado para esa instalación. El consumidor recibe IDs técnicos estables, riesgo, disponibilidad, metadata localizada e identidad del conector; no recibe autoridad de routing ni credenciales del sistema final.

### READ execution / Ejecución READ

The initial POST contract accepts only:

```json
{
  "toolId": "woocommerce.store.orders.get",
  "input": { "orderId": 42 },
  "actorReference": "employee-clara",
  "correlationId": "optional-product-correlation"
}
```

`actorReference` is provenance only. Platform namespaces it under the authenticated `consumerId`; it does not become an authentication or authorization principal.

`actorReference` sirve únicamente como procedencia. Platform lo namespacéa bajo el `consumerId` autenticado; no se convierte en principal de autenticación ni autorización.

The route delegates to the existing `AgentBridgeExecutionStore.queueReadCommand()`. Therefore the current consumer contract cannot use this endpoint to bypass tool risk classification or queue WRITE/CRITICAL operations.

La ruta delega en `AgentBridgeExecutionStore.queueReadCommand()`. Por tanto, el contrato consumer actual no permite saltarse la clasificación de riesgo ni encolar operaciones WRITE/CRITICAL mediante este endpoint.

### Command status / Estado del comando

The status route reads a command only inside the authenticated tenant and then verifies that it belongs to the installation bound to the credential. The returned command uses the existing sanitized projection: runtime session credentials and internal correlation fields remain hidden.

La ruta de estado lee el comando únicamente dentro del tenant autenticado y después verifica que pertenezca a la instalación ligada a la credencial. La respuesta utiliza la proyección saneada existente: las credenciales de sesión del runtime y campos internos de correlación permanecen ocultos.

## 4. Fail-closed behavior / Comportamiento fail-closed

The baseline contract fails closed when:

- consumer authentication is not configured;
- the bearer token is missing or invalid;
- the binding lacks the required permission;
- tool inventory or execution authority is unavailable;
- the caller attempts to supply routing authority;
- the requested READ tool is not currently executable for the bound installation.

El contrato base falla cerrado cuando la autenticación consumer no está configurada, el token falta o es inválido, faltan permisos, no existe autoridad de inventario/ejecución, el caller intenta enviar routing o el tool READ no está disponible para la instalación vinculada.

## 5. WRITE and CRITICAL boundary / Límite WRITE y CRITICAL

WRITE and CRITICAL operations are **intentionally outside v1**.

A later product-consumer mutation contract must reuse the existing Kairoseth approval, exact-action fingerprint, signed decision, nonce/replay protection, audit and command-delivery authorities. It must not create a product-specific approval engine and must not allow a machine consumer to self-approve mutations.

Las operaciones WRITE y CRITICAL quedan **intencionadamente fuera de v1**. Un contrato posterior de mutación deberá reutilizar las autoridades existentes de aprobación Kairoseth, fingerprint exacto de acción, decisión firmada, protección nonce/replay, auditoría y entrega de comandos. No podrá crear un motor de aprobación específico del producto ni permitir autoaprobación machine.

## 6. IA Empleado integration status / Estado de integración IA Empleado

IA Empleado is the first intended product consumer in the Agent Bridge integration order. A typed API-side adapter has been prepared in `Emmakex/ia-empleado` PR #868, but IA Empleado currently has `CURRENT_EXECUTION_POINTER: BETA` with an evidence-only work-selection rule.

Therefore the adapter must remain unmerged until a reproducible Reference Lab integration finding or a specific unmet Beta exit criterion authorizes that product change. The generic Platform consumer contract does not override IA Empleado roadmap governance.

IA Empleado es el primer consumidor previsto en el orden de integración de Agent Bridge. Se ha preparado un adaptador tipado en el PR #868 de `Emmakex/ia-empleado`, pero IA Empleado mantiene actualmente `CURRENT_EXECUTION_POINTER: BETA` con selección de trabajo basada exclusivamente en evidencia.

Por ello, el adaptador debe permanecer sin merge hasta que un hallazgo reproducible de integración en Reference Lab o un exit criterion BETA concreto autorice ese cambio. El contrato consumer genérico de Platform no sustituye la gobernanza del roadmap de IA Empleado.

## 7. Next authorized cuts / Siguientes cortes autorizados

Platform/Agent Bridge can continue to harden this generic boundary independently of product UI. Product-specific wiring follows the consumer product's own roadmap authority.

For IA Empleado, once BETA authority exists, the intended order remains:

1. server-side Tool Discovery wiring;
2. one real READ path;
3. approved WRITE using existing Kairoseth approval authority;
4. controlled Reference Lab acceptance with sanitized evidence.

Platform/Agent Bridge puede seguir endureciendo esta frontera genérica sin depender de UI de producto. El wiring específico de cada producto debe respetar la autoridad de su propio roadmap.

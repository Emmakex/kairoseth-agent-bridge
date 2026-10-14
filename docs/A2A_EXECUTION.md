# Kairoseth Agent Bridge — A2A Execution Profile v1

## ES

### Objetivo

El perfil de ejecución A2A permite que un agente A2A autenticado invoque herramientas publicadas por Kairoseth Agent Bridge sin crear una ruta de autorización paralela.

La ejecución siempre sigue este camino:

`A2A host autenticado -> extensión negociada -> A2A execution adapter -> BridgeRuntime -> policy -> approval -> connector -> audit`

`AgentSkill`, tags A2A, metadata de mensajes y parámetros enviados por el cliente son descriptivos/no confiables y nunca conceden permisos.

### Extensión

URI:

`https://kairoseth.com/a2a/extensions/tool-invocation/v1`

El host A2A debe negociar/activar explícitamente esta extensión. El `Message` también debe declarar la URI en `extensions`.

El Agent Card puede publicar la extensión en ES y EN. La URI, `required` y `params` deben ser semánticamente idénticos entre idiomas; solo la descripción visible se localiza.

### Mensaje de invocación

El baseline acepta exactamente un `Part.data` JSON con `mediaType: application/json`:

```json
{
  "version": "kairoseth.tool-invocation.v1",
  "toolId": "woocommerce.store.orders.get",
  "input": {
    "id": 123
  }
}
```

No se interpreta texto libre como comando. Tampoco se aceptan `raw`, `url`, cuerpos arbitrarios ni campos adicionales en el envelope de invocación.

### Identidad y alcance

`actor`, `tenantId`, `installationId`, `correlationId` y cualquier `approvalToken` proceden exclusivamente del host A2A autenticado. Nunca se leen desde `Message.metadata` ni desde `Part.metadata`.

Las tareas se almacenan con alcance exacto:

`actor + tenantId + installationId`

Conocer un `taskId` no concede acceso a la tarea.

### Estados

- `executed` del Bridge -> `TASK_STATE_COMPLETED` + `Artifact` JSON.
- `approval_required` -> `TASK_STATE_AUTH_REQUIRED`.
- `denied` -> `TASK_STATE_REJECTED`.
- `failed` -> `TASK_STATE_FAILED`.

Los mensajes de estado son ES/EN y no exponen errores internos del conector.

### Reanudación tras aprobación

Una tarea en `TASK_STATE_AUTH_REQUIRED` puede reanudarse únicamente con:

- mismo actor/tenant/installation;
- mismo `taskId`/`contextId`;
- mismo `toolId`;
- exactamente el mismo input/action fingerprint;
- aprobación proporcionada por el contexto confiable del host.

El adapter conserva el `correlationId` original para que la aprobación firmada siga ligada a la acción inicial. Cambiar el payload durante la reanudación se rechaza antes de ejecutar la herramienta.

### TaskStore

`InMemoryA2ATaskStore` es el baseline para tests/local/dev. Producción deberá inyectar un store durable y mantener exactamente el mismo aislamiento de scope. La persistencia/clusterización se endurecerá en la fase de producción.

## EN

### Goal

The A2A execution profile lets an authenticated A2A agent invoke tools published by Kairoseth Agent Bridge without introducing a parallel authorization path.

Execution always follows:

`authenticated A2A host -> negotiated extension -> A2A execution adapter -> BridgeRuntime -> policy -> approval -> connector -> audit`

`AgentSkill`, A2A tags, message metadata and client-supplied parameters are descriptive/untrusted and never grant permissions.

### Extension

URI:

`https://kairoseth.com/a2a/extensions/tool-invocation/v1`

The A2A host must explicitly negotiate/activate this extension. The `Message` must also declare the URI in `extensions`.

The Agent Card can publish the extension in ES and EN. URI, `required` and `params` must be semantically identical across languages; only the human/agent-facing description is localized.

### Invocation message

The baseline accepts exactly one JSON `Part.data` with `mediaType: application/json`:

```json
{
  "version": "kairoseth.tool-invocation.v1",
  "toolId": "woocommerce.store.orders.get",
  "input": {
    "id": 123
  }
}
```

Free text is never interpreted as a command. `raw`, `url`, arbitrary bodies and extra invocation-envelope fields are not accepted.

### Identity and scope

`actor`, `tenantId`, `installationId`, `correlationId` and any `approvalToken` come only from the authenticated A2A host. They are never read from `Message.metadata` or `Part.metadata`.

Tasks are stored under the exact scope:

`actor + tenantId + installationId`

Knowing a `taskId` never grants access to a task.

### States

- Bridge `executed` -> `TASK_STATE_COMPLETED` + JSON `Artifact`.
- `approval_required` -> `TASK_STATE_AUTH_REQUIRED`.
- `denied` -> `TASK_STATE_REJECTED`.
- `failed` -> `TASK_STATE_FAILED`.

Status messages are localized ES/EN and do not expose internal connector failures.

### Approval resume

A task in `TASK_STATE_AUTH_REQUIRED` can only resume with:

- the same actor/tenant/installation;
- the same `taskId`/`contextId`;
- the same `toolId`;
- the exact same input/action fingerprint;
- approval supplied through the trusted host context.

The adapter preserves the original `correlationId` so a signed approval remains bound to the original action. Changing the payload while resuming is rejected before tool execution.

### TaskStore

`InMemoryA2ATaskStore` is the baseline for tests/local/dev. Production deployments must inject a durable store while preserving the exact same scope isolation. Persistence/cluster hardening belongs to the production-hardening phase.

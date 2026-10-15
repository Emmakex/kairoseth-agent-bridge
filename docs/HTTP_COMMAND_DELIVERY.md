# HTTP Command Delivery / Entrega HTTP de comandos

## English

### Purpose

This transport binds the existing `kab.command.v1` / `kab.command-ack.v1` protocol to the outbound authenticated control session used by the production Agent Bridge runtime.

It does not change command authorization, approval, deduplication or execution semantics. Those remain owned by `CommandProcessor`, `BridgeRuntime`, the policy evaluator and the durable receipt/replay stores.

### Endpoints

The default Kairoseth Platform paths are:

- `POST /api/products/agent-bridge/commands/pull`
- `POST /api/products/agent-bridge/commands/ack`

Both calls use the current short-lived control-session access token as a Bearer credential. The runtime does not need an inbound listener.

A pull request contains only:

```json
{
  "sessionId": "session-...",
  "limit": 10
}
```

The successful response wraps one bounded command batch:

```json
{
  "batch": {
    "version": "kab.command-batch.v1",
    "batchId": "batch-...",
    "sessionId": "session-...",
    "commands": []
  }
}
```

The bridge validates the batch version, identifiers and configured maximum size before command processing. `CommandDeliveryClient` then verifies that the batch targets the active session and passes every command through the existing command processor.

An acknowledgement request contains:

```json
{
  "acknowledgement": {
    "version": "kab.command-ack.v1"
  }
}
```

The Platform may return any successful HTTP status without echoing sensitive command output.

### Scheduler

`CommandDeliveryScheduler` polls only while a non-expired control session exists.

Default cadence:

- active batch: 250 ms before the next pull;
- empty batch: 2 seconds;
- no active session: 2 seconds;
- transport/Platform failure: exponential retry from 1 second up to 30 seconds.

The scheduler itself never executes a tool directly. It creates a session-bound `CommandDeliveryClient`, so scope validation, command receipts and acknowledgements remain centralized in the Phase 1 command-delivery contract.

### Redelivery safety

A repeated `commandId` cannot silently execute twice.

The normal path remains:

1. validate command scope and fingerprint;
2. atomically claim the command receipt;
3. execute through `BridgeRuntime`;
4. persist the completed outcome;
5. send the ACK.

If the Platform redelivers a completed command because an ACK was lost, the runtime returns `duplicate` with the recorded original outcome and does not execute the tool again.

If a previous attempt is still/was left in `processing`, automatic re-execution remains blocked as `indeterminate`.

### Transport security

- HTTPS is mandatory outside localhost unless an explicit controlled-development opt-in is supplied by the deployment adapter.
- URL credentials, query strings and fragments are rejected from the control-plane base URL.
- redirects are rejected;
- requests use `Cache-Control: no-store`;
- Platform error bodies are not propagated; only a bounded machine-safe error code may be retained.

## Español

### Objetivo

Este transporte enlaza el protocolo ya existente `kab.command.v1` / `kab.command-ack.v1` con la sesión de control saliente y autenticada utilizada por el runtime de producción de Agent Bridge.

No modifica las reglas de autorización, aprobación, deduplicación o ejecución. Estas siguen perteneciendo a `CommandProcessor`, `BridgeRuntime`, al evaluador de políticas y a los almacenes duraderos de receipts/replay.

### Endpoints

Las rutas por defecto de Kairoseth Platform son:

- `POST /api/products/agent-bridge/commands/pull`
- `POST /api/products/agent-bridge/commands/ack`

Ambas llamadas usan como Bearer la credencial de acceso de la sesión de control de corta duración. El runtime no necesita abrir un listener de entrada.

La petición de extracción contiene únicamente:

```json
{
  "sessionId": "session-...",
  "limit": 10
}
```

La respuesta correcta envuelve un lote limitado de comandos:

```json
{
  "batch": {
    "version": "kab.command-batch.v1",
    "batchId": "batch-...",
    "sessionId": "session-...",
    "commands": []
  }
}
```

El bridge valida versión, identificadores y tamaño máximo antes de procesar los comandos. Después `CommandDeliveryClient` comprueba que el lote pertenece a la sesión activa y pasa cada comando por el procesador ya existente.

La petición de ACK contiene:

```json
{
  "acknowledgement": {
    "version": "kab.command-ack.v1"
  }
}
```

Kairoseth Platform puede responder con cualquier estado HTTP de éxito sin volver a enviar resultados sensibles del comando.

### Scheduler

`CommandDeliveryScheduler` solo consulta comandos cuando existe una sesión de control activa y no expirada.

Cadencia por defecto:

- lote con actividad: 250 ms antes de la siguiente consulta;
- lote vacío: 2 segundos;
- sin sesión activa: 2 segundos;
- fallo de transporte/Platform: retry exponencial desde 1 segundo hasta 30 segundos.

El scheduler nunca ejecuta herramientas directamente. Crea un `CommandDeliveryClient` ligado a la sesión actual, por lo que la validación de scope, los receipts y los ACK siguen centralizados en el contrato de entrega de comandos de la Fase 1.

### Seguridad ante redelivery

Un `commandId` repetido no puede volver a ejecutar silenciosamente una operación.

El flujo normal sigue siendo:

1. validar scope y fingerprint del comando;
2. reclamar atómicamente el receipt;
3. ejecutar mediante `BridgeRuntime`;
4. persistir el resultado completado;
5. enviar el ACK.

Si Platform vuelve a entregar un comando completado porque se perdió un ACK, el runtime responde `duplicate` con el resultado original registrado y no vuelve a ejecutar la herramienta.

Si el intento anterior permanece/quedó en `processing`, la reejecución automática continúa bloqueada como `indeterminate`.

### Seguridad del transporte

- HTTPS es obligatorio fuera de localhost salvo opt-in explícito para un entorno de desarrollo controlado.
- Se rechazan credenciales, query strings y fragments en la URL base del control plane.
- Se rechazan redirects.
- Las peticiones usan `Cache-Control: no-store`.
- Los cuerpos de error de Platform no se propagan; solo puede conservarse un código de error acotado y seguro para máquina.

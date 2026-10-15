# Kairoseth Agent Bridge — Secure Production Command Pipeline

## ES — Pipeline seguro de comandos en producción

### Objetivo

El runtime de producción no puede ejecutar comandos remotos usando un camino de seguridad reducido. La recepción HTTP de comandos reutiliza exactamente las mismas garantías ya definidas por el core de Agent Bridge.

El flujo operativo es:

```text
Kairoseth Platform
  -> sesión autenticada de corta duración
  -> sincronización de claves de aprobación
  -> pull de comando
  -> validación de scope + fingerprint
  -> aprobación firmada para WRITE/CRITICAL
  -> consumo atómico del nonce anti-replay
  -> claim durable del command receipt
  -> BridgeRuntime + política
  -> conector
  -> auditoría sanitizada durable
  -> ACK del comando
  -> entrega de auditoría a Platform
```

### Estado durable

El packaging de proceso único utiliza, dentro de `KAB_STATE_DIR`:

- `security/approval-keyset.json` — conjunto de claves de aprobación confiables;
- `security/approval-replay.json` — nonces de aprobación consumidos;
- `control/command-receipts.json` — receipts `processing/completed` para evitar reejecución incierta;
- `audit/outbox.json` — eventos ya sanitizados pendientes de ACK por Platform.

Estos archivos forman parte del estado durable de la instalación y **no deben eliminarse durante una actualización o rollback**.

### Política de ejecución

El `ProductionRuntime` construye `BridgeRuntime` con `SignedApprovalPolicyEvaluator`.

- `READ`: puede ejecutarse si la política lo permite.
- `WRITE`: requiere aprobación firmada válida.
- `CRITICAL`: requiere aprobación firmada válida.
- un nonce de aprobación solo puede consumirse una vez;
- reutilizar la misma aprobación con otro `commandId` se deniega;
- reutilizar el mismo `commandId` no vuelve a ejecutar el side effect: se responde desde el receipt durable.

No existe un flag de producción para desactivar silenciosamente estas protecciones.

### Claves de aprobación

La instalación arranca su trust root desde `trustedApprovalKeys` del binding emitido durante enrollment.

El runtime sincroniza nuevas generaciones mediante:

```text
POST /api/products/agent-bridge/approval-keys/sync
```

La actualización sigue verificándose criptográficamente contra una clave actualmente confiable antes de reemplazar el keyset persistido.

### Comandos

El runtime usa los endpoints:

```text
POST /api/products/agent-bridge/commands/pull
POST /api/products/agent-bridge/commands/ack
```

Ambos usan el Bearer de la sesión activa, `redirect: error` y `cache: no-store`.

### Auditoría

Los eventos se sanitizan **antes** de persistirse. Tool input/output, approval tokens, session tokens y secretos de conectores no forman parte del contrato de auditoría genérico.

La entrega usa:

```text
POST /api/products/agent-bridge/audit/batch
```

Platform confirma IDs individuales. Solo los eventos confirmados se eliminan del outbox.

### Lifecycle

El proceso ejecuta cinco loops bajo un único lifecycle:

1. sesión/heartbeat;
2. snapshot operativo;
3. sincronización de claves de aprobación;
4. comandos;
5. auditoría.

Cada scheduler gestiona fallos recuperables con retry/backoff. Si cualquiera de los loops termina de forma inesperada por un error de programación o invariant, el coordinador cancela todos los demás. El runtime no permanece medio operativo con seguridad, comandos o auditoría silenciosamente detenidos.

### Alcance de esta fase

Este baseline es para un runtime autoritativo de proceso único. Los file stores garantizan serialización dentro del proceso, pero **no** constituyen coordinación distribuida entre múltiples hosts.

Para despliegues clustered siguen pendientes stores compartidos con primitivas atómicas backend-level para:

- approval replay;
- command receipts;
- audit outbox cuando haya varios consumidores/productores.

---

## EN — Secure production command pipeline

### Goal

The production runtime must never execute remote commands through a reduced-security path. HTTP command delivery reuses the exact guarantees already defined by the Agent Bridge core.

The operational flow is:

```text
Kairoseth Platform
  -> short-lived authenticated session
  -> approval-key synchronization
  -> command pull
  -> scope + fingerprint validation
  -> signed approval for WRITE/CRITICAL
  -> atomic approval nonce consumption
  -> durable command receipt claim
  -> BridgeRuntime + policy
  -> connector
  -> durable sanitized audit
  -> command ACK
  -> audit delivery to Platform
```

### Durable state

The single-process packaging stores the following under `KAB_STATE_DIR`:

- `security/approval-keyset.json` — trusted approval-key set;
- `security/approval-replay.json` — consumed approval nonces;
- `control/command-receipts.json` — `processing/completed` receipts preventing unsafe re-execution;
- `audit/outbox.json` — already-sanitized events awaiting Platform ACK.

These files belong to the installation's durable state and **must not be deleted by update or rollback operations**.

### Execution policy

`ProductionRuntime` builds `BridgeRuntime` with `SignedApprovalPolicyEvaluator`.

- `READ`: may execute when policy allows it.
- `WRITE`: requires a valid signed approval.
- `CRITICAL`: requires a valid signed approval.
- an approval nonce can be consumed only once;
- reusing the same approval with another `commandId` is denied;
- redelivery of the same `commandId` does not repeat the side effect and is answered from the durable receipt.

There is no production flag that silently disables these protections.

### Approval keys

The installation bootstraps its trust root from `trustedApprovalKeys` in the enrollment binding.

The runtime synchronizes newer generations through:

```text
POST /api/products/agent-bridge/approval-keys/sync
```

A new keyset is still cryptographically verified by a currently trusted key before persisted state is replaced.

### Commands

The runtime uses:

```text
POST /api/products/agent-bridge/commands/pull
POST /api/products/agent-bridge/commands/ack
```

Both calls use the active session Bearer credential, `redirect: error`, and `cache: no-store`.

### Audit

Audit events are sanitized **before** persistence. Tool input/output, approval tokens, session tokens, and connector secrets are not part of the generic audit contract.

Delivery uses:

```text
POST /api/products/agent-bridge/audit/batch
```

Platform acknowledges individual event IDs. Only acknowledged records are removed from the outbox.

### Lifecycle

The process runs five loops under one lifecycle:

1. session/heartbeat;
2. operational snapshot;
3. approval-key synchronization;
4. commands;
5. audit.

Each scheduler owns recoverable retry/backoff. If any loop exits unexpectedly because of a programming error or invariant failure, the coordinator cancels every sibling loop. The runtime cannot remain half-operational with security, command, or audit processing silently stopped.

### Scope of this phase

This baseline targets one authoritative runtime process. File stores serialize operations inside that process, but they are **not** distributed coordination primitives across multiple hosts.

Clustered deployments still require shared backend-level atomic stores for:

- approval replay;
- command receipts;
- audit outbox when multiple producers/consumers are present.

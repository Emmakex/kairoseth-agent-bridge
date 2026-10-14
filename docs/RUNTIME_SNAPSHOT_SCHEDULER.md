# Kairoseth Agent Bridge — Runtime Snapshot Scheduler

## ES

### Objetivo

`RuntimeSnapshotScheduler` publica de forma periódica el inventario y health operativos usando la sesión de control que ya mantiene Agent Bridge.

El scheduler es deliberadamente independiente del heartbeat: un fallo al reportar el snapshot no invalida ni reinicia la sesión de control.

### Comportamiento

- si todavía no existe sesión, no envía nada y vuelve a comprobar después de un intervalo corto;
- si la sesión actual está expirada, no usa su token;
- si hay una sesión válida, toma el `accessToken` de esa sesión en memoria y llama al reporter;
- después de un reporte correcto espera el intervalo normal, 60 s por defecto;
- los fallos de snapshot aplican backoff acotado independiente;
- en cada tick vuelve a consultar la sesión actual, de modo que una renovación/rotación se adopta sin reiniciar el runtime;
- `AbortSignal` permite detener el loop limpiamente.

### Seguridad

El scheduler no persiste tokens ni los incluye en logs o snapshots. Solo entrega el token corto en memoria a `RuntimeSnapshotReporter`, cuyo transporte lo envía por `Authorization: Bearer`.

El reporter y el scheduler siguen siendo observabilidad. No cambian policy, approvals, audit ni permisos de ejecución.

## EN

### Goal

`RuntimeSnapshotScheduler` periodically publishes operational inventory and health using the control session already maintained by Agent Bridge.

The scheduler is deliberately independent from heartbeat: a snapshot reporting failure does not invalidate or restart the control session.

### Behavior

- when no session exists yet, nothing is sent and the scheduler checks again after a short delay;
- an expired current session token is never used;
- with a valid session, the scheduler reads that session's in-memory `accessToken` and calls the reporter;
- after a successful report it waits the normal interval, 60 seconds by default;
- snapshot failures use an independent bounded backoff;
- every tick reads the current session again, so renewed/rotated sessions are adopted without restarting the runtime;
- `AbortSignal` stops the loop cleanly.

### Security

The scheduler does not persist tokens or include them in logs or snapshots. It only passes the short-lived in-memory token to `RuntimeSnapshotReporter`, whose transport sends it in `Authorization: Bearer`.

Reporter and scheduler remain observability only. They do not change policy, approvals, audit, or execution permissions.

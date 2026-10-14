# Kairoseth Agent Bridge — Control Plane Runtime Coordinator

## ES

### Objetivo

`ControlPlaneRuntimeCoordinator` une el ciclo de vida de los dos procesos largos que mantienen un runtime conectado con Kairoseth Platform:

- `ControlSessionSupervisor`: sesión autenticada, renovación y heartbeat;
- `RuntimeSnapshotScheduler`: inventario/health operativo reportado periódicamente.

El coordinador no añade una ruta de ejecución ni una autoridad nueva. Policy, aprobaciones, RBAC, auditoría y `BridgeRuntime` siguen siendo controles independientes.

### Aislamiento operativo

Los fallos normales del endpoint de snapshot siguen gestionados dentro de `RuntimeSnapshotScheduler` con retry/backoff. Un error de observabilidad no invalida la sesión activa ni detiene heartbeat.

El coordinador actúa solo ante una terminación inesperada del propio loop:

1. ambos loops reciben la misma señal interna de ciclo de vida;
2. si uno termina o lanza un fallo de programación/runtime sin cancelación externa, el coordinador aborta el otro;
3. espera a que ambos hayan cerrado;
4. propaga el error original, o genera un error explícito si un loop terminó silenciosamente;
5. una cancelación externa normal detiene ambos sin convertir el shutdown en fallo.

Esto evita dejar un runtime en estado parcial, por ejemplo con snapshots activos pero sin sesión/heartbeat, o con heartbeat activo mientras el scheduler principal ha desaparecido por un fallo no controlado.

### Uso esperado

El host del runtime construye una sola vez:

- `ControlSessionSupervisor`;
- `RuntimeSnapshotReporter` + `RuntimeSnapshotScheduler`;
- `ControlPlaneRuntimeCoordinator`.

Después ejecuta `coordinator.run(readinessProvider, signal)` durante la vida del proceso.

El scheduler siempre obtiene la sesión actual a través del supervisor. Por tanto, una renovación de sesión cambia el access token usado para el siguiente snapshot sin reiniciar el runtime.

### Seguridad

El coordinador no persiste access tokens, no copia credenciales y no inspecciona payloads de herramientas. Solo comparte `AbortSignal` y la función de readiness entre componentes que ya tienen contratos propios.

## EN

### Goal

`ControlPlaneRuntimeCoordinator` joins the lifecycle of the two long-running processes that keep a runtime connected to Kairoseth Platform:

- `ControlSessionSupervisor`: authenticated session, renewal, and heartbeat;
- `RuntimeSnapshotScheduler`: periodic operational inventory/health reporting.

The coordinator does not add an execution path or a new authority. Policy, approvals, RBAC, audit, and `BridgeRuntime` remain independent controls.

### Operational isolation

Ordinary snapshot endpoint failures remain handled inside `RuntimeSnapshotScheduler` with retry/backoff. An observability failure does not invalidate the active session or stop heartbeat.

The coordinator acts only when a long-running loop itself terminates unexpectedly:

1. both loops receive the same internal lifecycle signal;
2. if one returns or throws a programming/runtime failure without external cancellation, the coordinator aborts the other;
3. it waits until both loops have closed;
4. it propagates the original error, or raises an explicit error when a loop stopped silently;
5. normal external cancellation stops both loops without turning shutdown into a failure.

This prevents a partially running runtime, for example snapshots continuing without session/heartbeat, or heartbeat continuing after the main snapshot scheduler has disappeared because of an unhandled failure.

### Expected usage

The runtime host constructs once:

- `ControlSessionSupervisor`;
- `RuntimeSnapshotReporter` + `RuntimeSnapshotScheduler`;
- `ControlPlaneRuntimeCoordinator`.

It then runs `coordinator.run(readinessProvider, signal)` for the lifetime of the process.

The scheduler always reads the current session through the supervisor. Session renewal therefore changes the access token used for the next snapshot without restarting the runtime.

### Security

The coordinator does not persist access tokens, copy credentials, or inspect tool payloads. It only shares lifecycle cancellation and readiness between components that already enforce their own contracts.

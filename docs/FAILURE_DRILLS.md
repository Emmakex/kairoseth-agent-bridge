# Agent Bridge — Failure drills / Simulacros de fallo

## ES

### Propósito

Phase 6 exige demostrar que los controles siguen funcionando durante fallos, carreras y redelivery, no solo en el happy path. `tests/acceptance/phase6-failure-drills.test.ts` concentra escenarios cruzados que usan componentes reales del runtime.

### Drill FD-01 — Snapshot endpoint temporalmente caído

Se fuerza un error del reporter de snapshots y después una recuperación. El scheduler debe aplicar retry/backoff sin invalidar la sesión ni matar el lifecycle del control plane. El shutdown posterior debe ser una cancelación normal, no un fallo falso.

Criterio de éxito: primer report falla, segundo report funciona, el error queda aislado y el loop de sesión solo termina cuando llega el abort externo.

### Drill FD-02 — Control session termina por fallo fatal

Se fuerza una excepción inesperada del loop de sesión mientras el scheduler está activo.

Criterio de éxito: `ControlPlaneRuntimeCoordinator` aborta el scheduler, espera su cierre y propaga el error original. No queda un runtime parcialmente vivo publicando snapshots sin control session.

### Drill FD-03 — Redelivery durante una mutación

Dos processors comparten el mismo receipt store y reciben el mismo command mientras el primer side effect todavía está en curso.

Criterio de éxito: solo un caller obtiene el claim, el segundo queda `indeterminate` sin ejecutar de nuevo, y cualquier entrega posterior al completion devuelve `duplicate` con el outcome original. El contador de side effects permanece en uno.

### Drill FD-04 — Backend/tool roto con sibling sano

Una tool produce un error transient y abre su circuit breaker. Otra tool del mismo connector instance permanece sana.

Criterio de éxito: la tool fallida empieza a fallar rápido sin más llamadas al backend mientras el circuito está abierto y la tool sana continúa ejecutándose.

### Rollback

Estos drills validan comportamiento de fallo del runtime. El rollback de una versión instalada todavía no se marca como completo porque depende de la estrategia de instalación/update/anti-downgrade y del packaging Docker/Linux/Windows. Cuando esa capa exista, el drill de rollback debe partir de un artifact atestado conocido, desplegar una versión candidata, forzar un health/acceptance failure y restaurar exactamente el digest previo sin regenerar el artifact.

## EN

### Purpose

Phase 6 must prove that controls survive failures, races, and redelivery rather than only passing happy-path tests. `tests/acceptance/phase6-failure-drills.test.ts` concentrates cross-component scenarios using real runtime components.

### Drill FD-01 — Temporary snapshot endpoint outage

The snapshot reporter is forced to fail and then recover. The scheduler must retry/back off without invalidating the session or killing the control-plane lifecycle. Later shutdown must remain a normal cancellation rather than a false failure.

Success: first report fails, second report succeeds, the error remains isolated, and the session loop stops only after external abort.

### Drill FD-02 — Fatal control-session termination

The session loop is forced to throw unexpectedly while the snapshot scheduler is active.

Success: `ControlPlaneRuntimeCoordinator` aborts the scheduler, waits for closure, and propagates the original error. No half-running runtime remains publishing snapshots without a control session.

### Drill FD-03 — Redelivery during a mutation

Two processors share the same receipt store and receive the same command while the first side effect is still running.

Success: only one caller wins the claim, the second becomes `indeterminate` without re-executing, and later deliveries return `duplicate` with the original outcome. The side-effect count stays at one.

### Drill FD-04 — Broken backend/tool with healthy sibling

One tool raises a transient backend failure and opens its circuit while another tool in the same connector instance remains healthy.

Success: the failed tool begins failing fast without extra backend calls while its circuit is open, and the healthy tool remains executable.

### Rollback

These drills validate runtime failure behavior. Installed-version rollback is not marked complete yet because it depends on installation/update/anti-downgrade strategy plus Docker/Linux/Windows packaging. Once that layer exists, the rollback drill must start from a known attested artifact, deploy a candidate, force a health/acceptance failure, and restore the exact previous digest without rebuilding the artifact.

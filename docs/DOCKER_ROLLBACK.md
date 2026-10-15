# Agent Bridge — Docker installed rollback / rollback Docker instalado

## ES

### Propósito

Este adapter materializa en Docker la política platform-neutral definida en `INSTALLATION_UPDATE_STRATEGY.md` sin crear reglas de versión alternativas.

Hay dos identidades distintas y ambas se conservan:

1. **release descriptor**: `packageVersion + artifactSha256 + sourceCommit`;
2. **Docker image ID**: `sha256:<64 hex>` devuelto por Docker para los bytes/configuración exactos de la imagen local.

El SHA-256 del tar de Release Integrity **no es** el Docker image ID y nunca deben intercambiarse.

### Plan de activación

`buildDockerRuntimeActivationPlan()` aplica primero `evaluateRuntimeUpdate()` y añade la identidad OCI local.

El plan falla cerrado cuando:

- el image ID actual no es un `sha256:` inmutable;
- el image ID candidato no es inmutable;
- un descriptor de release ya instalado aparece bajo otro image ID;
- el downgrade no corresponde al rollback target exacto;
- un candidate no tiene opt-in explícito;
- el rollback target contiene un image ID inválido.

Para una actualización aceptada, el plan conserva el image ID actual como `rollbackImageId`.

### Adapter físico

`packaging/docker/activate-with-rollback.sh` soporta:

```text
activate
rollback
finalize
```

Se ejecuta explícitamente con `bash`; el archivo no depende del bit ejecutable del checkout.

Variables principales:

```text
KAB_CONTAINER_NAME
KAB_ROLLBACK_CONTAINER_NAME
KAB_STATE_VOLUME
KAB_CANDIDATE_IMAGE
KAB_EXPECTED_CURRENT_IMAGE_ID
KAB_EXPECTED_CANDIDATE_IMAGE_ID
KAB_ENV_FILE                    # opcional
KAB_HEALTH_TIMEOUT_SECONDS
KAB_RESTART_POLICY
```

### `activate`

Antes de modificar la instalación, el adapter:

1. exige que exista el contenedor activo;
2. rechaza sobrescribir un contenedor `.rollback` existente;
3. verifica el image ID exacto del contenedor actual;
4. resuelve la referencia candidata con `docker image inspect` y compara su image ID exacto;
5. exige que el runtime actual esté `healthy`;
6. exige que el volumen durable exista.

Después:

1. detiene el contenedor actual con su `STOPSIGNAL`;
2. lo renombra a `<container>.rollback`;
3. inicia la candidata **por image ID exacto**, no por tag mutable;
4. monta el mismo volumen en `/var/lib/agent-bridge`;
5. espera el health gate.

Si la candidata llega a `healthy`, queda activa y el contenedor anterior permanece detenido como rollback target hasta `finalize`.

### Rollback automático

Si la candidata no arranca o no alcanza `healthy`:

1. se elimina la candidata fallida;
2. se verifica que el contenedor retenido sigue usando el image ID anterior esperado;
3. se renombra otra vez al nombre productivo;
4. se inicia el contenedor anterior;
5. se espera su health gate;
6. se vuelve a verificar el image ID restaurado.

Resultados especiales:

- `20`: la activación candidata falló, pero el rollback exacto terminó correctamente;
- `21`: la candidata falló y el rollback no pudo demostrar una restauración sana; el sistema falla cerrado y requiere intervención.

### Rollback manual

Mientras exista el contenedor retenido, `rollback` permite restaurarlo incluso después de una activación inicialmente sana.

Requiere otra vez el image ID esperado. El adapter no acepta “la versión anterior” por nombre o tag: restaura solo el contenedor asociado al image ID exacto declarado.

### Finalización

`finalize` elimina únicamente el contenedor de rollback y solo después de comprobar su image ID.

El volumen durable no se elimina. La retención del rollback target debe cerrarse por una decisión explícita de operación, no automáticamente en el momento de una activación sana.

### Estado durable

El mismo named volume acompaña al runtime activo y a cualquier candidato:

```text
<state volume> -> /var/lib/agent-bridge
```

Por tanto, actualización y rollback no sustituyen:

- identidad Ed25519;
- installation binding;
- approval keyset;
- approval replay records;
- command receipts;
- audit outbox;
- estado futuro que forme parte de `KAB_STATE_DIR`.

El rollback cambia código/runtime; no retrocede ni borra el estado durable.

### Drill real de CI

`tests/acceptance/docker-installed-rollback.sh` ejecuta Docker real en CI:

1. construye una imagen anterior sana;
2. crea un named volume;
3. arranca y valida el runtime anterior;
4. construye una candidata cuyo healthcheck falla deliberadamente;
5. ejecuta `activate` con ambos image IDs exactos;
6. exige resultado `20`;
7. comprueba que el contenedor activo vuelve al image ID anterior;
8. comprueba `healthy`;
9. comprueba que el marcador anterior y el creado durante el intento candidato siguen en el mismo volumen;
10. comprueba que no queda un contenedor rollback huérfano tras la restauración automática.

Esto cierra el drill de rollback **instalado** para el baseline Docker de proceso único. No implica todavía promoción OCI estable ni rollout clusterizado.

---

## EN

### Purpose

This adapter materializes the platform-neutral policy in `INSTALLATION_UPDATE_STRATEGY.md` for Docker without inventing separate version rules.

Two different identities are preserved:

1. **release descriptor**: `packageVersion + artifactSha256 + sourceCommit`;
2. **Docker image ID**: the immutable local `sha256:<64 hex>` image identity resolved by Docker.

The Release Integrity tar SHA-256 is **not** the Docker image ID and the two must never be substituted for one another.

### Activation plan

`buildDockerRuntimeActivationPlan()` first applies `evaluateRuntimeUpdate()` and then binds the decision to the local OCI image identity.

The plan fails closed for invalid current/candidate image IDs, release/image collisions, unauthorized downgrades, candidate releases without opt-in, or invalid trusted rollback image identity.

An accepted update preserves the exact active image ID as `rollbackImageId`.

### Physical adapter

`packaging/docker/activate-with-rollback.sh` supports:

```text
activate
rollback
finalize
```

Invoke it explicitly with `bash`; behavior does not depend on the checkout executable bit.

Main environment inputs are:

```text
KAB_CONTAINER_NAME
KAB_ROLLBACK_CONTAINER_NAME
KAB_STATE_VOLUME
KAB_CANDIDATE_IMAGE
KAB_EXPECTED_CURRENT_IMAGE_ID
KAB_EXPECTED_CANDIDATE_IMAGE_ID
KAB_ENV_FILE                    # optional
KAB_HEALTH_TIMEOUT_SECONDS
KAB_RESTART_POLICY
```

### `activate`

Before touching the installation, the adapter requires the active container, refuses to overwrite an existing rollback container, verifies the exact current image ID, resolves and verifies the candidate image ID, requires current health, and requires the durable volume.

It then stops and renames the current container, starts the candidate **by exact image ID**, mounts the same state volume, and waits for the Docker health gate.

A healthy candidate becomes active while the prior stopped container is retained until explicit finalization.

### Automatic rollback

If the candidate fails startup or health:

1. the failed candidate is removed;
2. the retained container image ID is re-verified;
3. the prior container is renamed back to the production name;
4. it is started and health-gated;
5. its restored image ID is verified again.

Special results:

- `20`: candidate activation failed and exact automatic rollback succeeded;
- `21`: candidate activation failed and rollback could not prove a healthy exact restore; the adapter fails closed for operator intervention.

### Manual rollback

While the retained container exists, `rollback` can restore it after an initially successful activation. The expected immutable image ID is mandatory; a mutable tag or a vague “previous version” is not sufficient.

### Finalization

`finalize` removes only the retained rollback container after verifying its image ID. It never removes the durable state volume.

### Durable state

The same named volume is mounted at `/var/lib/agent-bridge` for the active runtime and candidates. Update and rollback therefore preserve installation identity, binding, approval keys, replay records, command receipts, audit outbox, and future durable `KAB_STATE_DIR` data.

Rollback changes runtime code; it does not rewind or delete durable state.

### Real CI drill

`tests/acceptance/docker-installed-rollback.sh` uses real Docker to install a healthy prior image, activate a deliberately unhealthy candidate, require result `20`, prove the exact prior image ID is restored healthy, prove state survives across both containers, and prove no stale rollback container remains after automatic restoration.

This closes the **installed rollback drill** for the single-process Docker baseline. It does not yet claim stable OCI promotion or clustered rollout support.

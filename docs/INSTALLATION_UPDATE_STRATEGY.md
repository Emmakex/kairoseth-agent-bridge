# Agent Bridge — installation/update strategy / estrategia de instalación y actualización

## ES

### Objetivo

El core de actualización debe ser idéntico para instalaciones locales aunque el wrapper final sea Docker, systemd/Linux, Windows Service o un runtime integrado en otro producto. Los adapters de packaging pueden cambiar el mecanismo de activación, pero no las reglas de integridad, anti-downgrade, identidad o rollback.

### Separación obligatoria de estado

Una instalación debe separar al menos:

- **release directory**: código/runtime inmutable de una versión concreta;
- **current pointer**: referencia atómica a la release activa;
- **state directory**: bridge identity, installation binding, replay/idempotency receipts, colas y demás estado durable;
- **secret provider**: credenciales fuera del release directory;
- **logs/observability**: fuera del release directory.

Actualizar o hacer rollback nunca debe sustituir la identidad Ed25519 ni borrar el binding de instalación, receipts o secretos.

### Release descriptor

`RuntimeReleaseDescriptor` usa `kab.runtime-release.v1` y fija:

- technical product ID `agent-bridge`;
- package version;
- SHA-256 exacto del artifact;
- source commit;
- channel `stable` o `candidate`.

La metadata recibida no autoriza por sí sola a ejecutar el artifact. Antes de activarlo se verifica el digest descargado y, en la capa de distribución, su provenance/attestation debe corresponder al repositorio/workflow esperado.

### Política anti-downgrade

`evaluateRuntimeUpdate` aplica estas reglas:

1. misma versión + mismo digest => `noop`;
2. misma versión + digest distinto => rechazo por collision;
3. versión superior válida => `update`;
4. candidate => requiere opt-in explícito salvo rollback exacto previamente confiado;
5. versión inferior => rechazo por defecto;
6. rollback => solo versión + digest + source commit exactamente iguales al `trustedRollbackTarget` previamente instalado.

No existe una opción genérica `allowDowngrade=true`. El rollback es una excepción estrecha a un artifact conocido, no permiso para instalar cualquier versión antigua.

### Flujo de instalación/update

1. Resolver desired release desde el control plane/canal de despliegue autorizado.
2. Evaluar `RuntimeReleaseDescriptor` contra la release instalada.
3. Descargar a un staging directory nuevo, sin tocar `current`.
4. Verificar SHA-256 con `assertRuntimeArtifactFileIntegrity`.
5. Verificar provenance/SBOM attestation según la política de distribución.
6. Extraer en un directorio versionado nuevo con permisos mínimos.
7. Ejecutar preflight: estructura esperada, Node compatible, config no secreta y acceso al state directory.
8. Iniciar candidate de forma aislada o ejecutar startup/self-test sin asumir control definitivo.
9. Pasar health/readiness gate y un acceptance mínimo del control channel.
10. Cambiar `current` de forma atómica.
11. Mantener la release anterior y su descriptor exacto como rollback target durante la ventana definida.
12. Eliminar releases antiguas solo después de una política explícita de retención.

### Rollback

Un rollback automático solo debe ocurrir después de un fallo de activación/health dentro de la ventana de actualización y únicamente hacia el descriptor anterior guardado antes del switch.

El proceso de rollback no reconstruye el artifact anterior. Restaura el exacto digest previamente verificado. Si falta el artifact previo o su digest no coincide, el sistema debe fallar cerrado y requerir intervención en lugar de ejecutar bytes desconocidos.

### Alcance actual

La política y verificación de digest son ya platform-neutral. Todavía faltan los adapters concretos que materializan el switch/health/rollback en Docker, Linux service y Windows service. Esos adapters deben reutilizar esta política y no reimplementar reglas de versión diferentes.

## EN

### Goal

The update core must remain identical across local installations even when the final wrapper is Docker, systemd/Linux, Windows Service, or a runtime embedded in another product. Packaging adapters may change activation mechanics but not integrity, anti-downgrade, identity, or rollback rules.

### Mandatory state separation

An installation separates immutable versioned release code, an atomic `current` pointer, durable state (identity/binding/replay/idempotency/queues), external secret providers, and logs/observability. Update or rollback never replaces the Ed25519 identity or silently deletes installation binding, receipts, or secrets.

### Release descriptor

`RuntimeReleaseDescriptor` (`kab.runtime-release.v1`) binds technical product ID `agent-bridge`, package version, exact artifact SHA-256, source commit, and `stable`/`candidate` channel.

Metadata alone is not execution authority. The downloaded artifact digest is verified before activation and the distribution layer must verify expected provenance/attestation.

### Anti-downgrade policy

`evaluateRuntimeUpdate` enforces:

1. same version + same digest => `noop`;
2. same version + different digest => collision rejection;
3. valid higher version => `update`;
4. candidate releases require explicit opt-in except an exact previously trusted rollback;
5. lower versions are rejected by default;
6. rollback requires exact version + digest + source commit equality with the previously installed `trustedRollbackTarget`.

There is intentionally no generic `allowDowngrade=true`; rollback is a narrow exception for a known artifact.

### Installation/update flow

1. Resolve desired release through the authorized control/deployment channel.
2. Evaluate the descriptor against the installed release.
3. Download into a new staging directory without touching `current`.
4. Verify SHA-256 with `assertRuntimeArtifactFileIntegrity`.
5. Verify provenance/SBOM attestation under distribution policy.
6. Extract into a new versioned directory with least privilege.
7. Run preflight for structure, Node compatibility, non-secret config, and state access.
8. Start the candidate in isolation or run startup/self-test without assuming final authority.
9. Pass health/readiness plus a minimal control-channel acceptance gate.
10. Atomically switch `current`.
11. Preserve the exact previous release descriptor/artifact as rollback target for the defined window.
12. Remove old releases only under an explicit retention policy.

### Rollback

Automatic rollback is limited to activation/health failure inside the update window and only to the exact descriptor captured before switching.

Rollback never rebuilds the prior artifact. It restores the previously verified digest. If the prior bytes are unavailable or no longer match their digest, the updater fails closed rather than executing unknown content.

### Current scope

The policy and digest verification are platform-neutral and implemented. Concrete Docker/Linux/Windows adapters that materialize switching, health gating, and rollback remain future Phase 6 slices and must reuse this policy rather than inventing separate version rules.

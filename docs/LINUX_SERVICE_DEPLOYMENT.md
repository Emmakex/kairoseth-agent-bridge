# Linux systemd deployment — Integración de agentes de IA / AI Integration

This document defines the Linux service packaging baseline for the technical `kairoseth-agent-bridge` runtime. The customer-facing product names remain **Integración de agentes de IA** (ES) and **AI Integration** (EN); technical service, paths, protocol IDs and release descriptors remain locale-independent.

---

## ES — Despliegue Linux con systemd

### Objetivo

El runtime Linux debe poder instalarse, actualizarse y revertirse sin reconstruir el código en el servidor del cliente y sin mezclar los binarios de una versión con identidad, binding, receipts, auditoría o secretos persistentes.

El modelo conserva la frontera existente:

- Kairoseth Platform es el plano de control;
- Agent Bridge es el runtime de ejecución/datos;
- la conexión de control es saliente;
- el servicio no abre un puerto de escucha por defecto.

### Requisitos

Baseline soportada:

- Linux con `systemd`;
- Node.js 22 o superior disponible en `/usr/bin/node` o configurado explícitamente en el instalador;
- usuario con privilegios de administración para la instalación inicial;
- acceso saliente HTTPS hacia Kairoseth Platform y hacia los sistemas que requieran los conectores configurados.

El host **no necesita TypeScript, npm de desarrollo ni compilar `src/`**. El bundle Linux se genera desde el mismo `dist/src` ya verificado por Release Integrity e incluye únicamente dependencias de producción instaladas con el lockfile.

### Layout del host

```text
/opt/agent-bridge/
  releases/
    sha256-<runtime-artifact-sha256>/
  current -> releases/sha256-...
  previous -> releases/sha256-...   # solo durante una ventana de actualización

/etc/agent-bridge/
  agent-bridge.env

/var/lib/agent-bridge/
  identity/
  installation/
  security/
  control/
  audit/
  runtime/
```

La carpeta `releases/sha256-...` es inmutable por diseño. Su nombre está ligado al SHA-256 del artefacto runtime de la release. `current` y `previous` son punteros atómicos; el estado durable queda fuera de ambos.

Una actualización o rollback **no debe**:

- regenerar la identidad Ed25519;
- borrar el binding de instalación;
- borrar replay receipts o command receipts;
- borrar la audit outbox;
- incluir secretos dentro del release;
- modificar silenciosamente `/etc/agent-bridge/agent-bridge.env`.

### Bundle verificable

Release Integrity produce un bundle Linux determinista junto al runtime genérico y al OCI image bundle. El bundle contiene:

- `runtime-release.json`;
- `dist/src` precompilado;
- `node_modules` de producción obtenidos con `npm ci --omit=dev` y el lockfile de la release;
- `package.json` y `package-lock.json`;
- unidad `agent-bridge.service`;
- instalador y adaptador de activación/rollback;
- ejemplo de entorno;
- esta documentación ES/EN.

El SHA-256 del bundle se incorpora a `SHA256SUMS` y a `release-manifest.json`. En `main`, el bundle recibe una attestation de provenance independiente.

### Instalación

El bundle debe verificarse antes de extraerlo:

```bash
sudo bash packaging/linux/install-bundle.sh \
  ./agent-bridge-<version>-<commit>-linux-x64.tar.gz \
  <linux-bundle-sha256>
```

El instalador:

1. compara el SHA-256 exacto del bundle;
2. rechaza rutas absolutas o traversal dentro del archivo;
3. valida Node.js >= 22;
4. valida `runtime-release.json`;
5. instala en `releases/sha256-<artifactSha256>`;
6. rechaza una colisión si ese directorio ya contiene metadatos diferentes;
7. crea el usuario/grupo técnico `agent-bridge` si no existen;
8. instala la unidad systemd;
9. crea `/etc/agent-bridge/agent-bridge.env` solo si aún no existe;
10. preserva `/var/lib/agent-bridge`;
11. inicializa `current` solo cuando no existe ningún puntero activo;
12. ejecuta `daemon-reload`.

El instalador **no inicia automáticamente** el servicio. La primera instalación debe completar el enrollment antes de arrancar el runtime permanente.

### Configuración

Editar:

```text
/etc/agent-bridge/agent-bridge.env
```

Baseline:

```dotenv
KAB_PLATFORM_BASE_URL=https://kairoseth.com
KAB_STATE_DIR=/var/lib/agent-bridge
KAB_DEPLOYMENT_MODE=local
KAB_ALLOW_INSECURE_HTTP=false
```

Los secretos de conectores deben resolverse mediante el `SecretProvider` del deployment. No deben hornearse en el bundle ni escribirse en el unit file.

### Enrollment inicial

El enrollment token es de un solo uso y no debe persistirse en `agent-bridge.env`.

Ejemplo con archivo temporal protegido:

```bash
sudo -u agent-bridge \
  KAB_ENROLLMENT_TOKEN_FILE=/run/agent-bridge/enrollment-token \
  /usr/bin/node \
  /opt/agent-bridge/current/dist/src/cli/agent-bridge-runtime.js enroll
```

Después del enrollment, eliminar/revocar el token temporal según la política del plano de control.

### Arranque

```bash
sudo systemctl enable --now agent-bridge.service
sudo systemctl status agent-bridge.service
```

El health local no necesita HTTP:

```bash
sudo -u agent-bridge \
  KAB_STATE_DIR=/var/lib/agent-bridge \
  /usr/bin/node \
  /opt/agent-bridge/current/dist/src/cli/agent-bridge-runtime.js healthcheck
```

El healthcheck valida el estado persistido reciente y que el PID siga vivo.

### Hardening de systemd

La unidad baseline incluye, entre otros:

- usuario y grupo dedicados;
- `StateDirectory=agent-bridge` con modo `0700`;
- `UMask=0077`;
- `NoNewPrivileges=true`;
- `ProtectSystem=strict`;
- `ProtectHome=true`;
- protección de kernel/control groups/clock;
- `PrivateTmp=true` y `PrivateDevices=true`;
- `CapabilityBoundingSet=` y `AmbientCapabilities=` vacíos;
- `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6`;
- escritura limitada al estado durable;
- `SIGTERM` y timeout de parada explícitos.

No se aplica `MemoryDenyWriteExecute` por defecto porque el runtime Node/V8 puede necesitar memoria ejecutable para JIT. Un deployment con políticas adicionales puede endurecer más la unidad después de pruebas sobre su workload real.

### Actualización segura

El plano de actualización reutiliza exactamente la política de release común:

- misma versión + mismo digest -> `noop`;
- misma versión + digest distinto -> rechazo;
- versión nueva válida -> update;
- candidate -> requiere opt-in explícito;
- downgrade arbitrario -> bloqueado;
- rollback -> solo al descriptor exacto de la release previa confiable.

Además, Linux liga el descriptor a un directorio inmutable:

```text
/opt/agent-bridge/releases/sha256-<artifactSha256>
```

La activación necesita el digest actual y el digest candidato esperados:

```bash
sudo \
  KAB_CANDIDATE_RELEASE_PATH=/opt/agent-bridge/releases/sha256-<candidate> \
  KAB_EXPECTED_CURRENT_ARTIFACT_SHA256=<current> \
  KAB_EXPECTED_CANDIDATE_ARTIFACT_SHA256=<candidate> \
  bash packaging/linux/activate-with-rollback.sh activate
```

Flujo:

1. valida `current` y candidato contra sus descriptores y nombres digest-bound;
2. exige que el runtime actual esté healthy;
3. detiene el servicio;
4. guarda `previous` apuntando exactamente al release anterior;
5. conmuta `current` atómicamente al candidato;
6. inicia el servicio;
7. espera health local;
8. si el candidato falla, restaura exactamente `previous` y vuelve a comprobar health.

Códigos especiales:

- `0`: candidato healthy, `previous` queda retenido hasta `finalize`;
- `20`: activación falló y el rollback exacto anterior volvió healthy;
- `21`: activación falló y el rollback automático no pudo confirmarse; intervención obligatoria.

### Rollback manual y finalize

Mientras `previous` exista:

```bash
sudo \
  KAB_EXPECTED_ROLLBACK_ARTIFACT_SHA256=<previous> \
  bash packaging/linux/activate-with-rollback.sh rollback
```

Después de una ventana de observación satisfactoria:

```bash
sudo \
  KAB_EXPECTED_ROLLBACK_ARTIFACT_SHA256=<previous> \
  bash packaging/linux/activate-with-rollback.sh finalize
```

`finalize` elimina únicamente el puntero `previous`. No borra automáticamente los bytes históricos ni el estado. Una política de retención posterior puede eliminar releases antiguas solo cuando ya no sean current/previous y exista evidencia suficiente para recuperarlas desde distribución.

---

## EN — Linux deployment with systemd

### Goal

The Linux runtime must be installable, updatable and rollback-safe without rebuilding application code on the customer host and without mixing release bytes with persistent identity, binding, receipts, audit data or secrets.

The existing architecture remains authoritative:

- Kairoseth Platform is the control plane;
- Agent Bridge is the execution/data-plane runtime;
- the control connection is outbound;
- the service exposes no listening port by default.

### Requirements

Baseline:

- Linux with `systemd`;
- Node.js 22 or newer at `/usr/bin/node`, or an explicit installer override;
- administrative privileges for initial installation;
- outbound HTTPS access to Kairoseth Platform and to connector-specific business systems.

The target host does **not** compile TypeScript. The Linux bundle consumes the same verified `dist/src` tree used by Release Integrity and includes production dependencies installed from the committed lockfile.

### Host layout

```text
/opt/agent-bridge/
  releases/
    sha256-<runtime-artifact-sha256>/
  current -> releases/sha256-...
  previous -> releases/sha256-...   # only during an update window

/etc/agent-bridge/
  agent-bridge.env

/var/lib/agent-bridge/
  identity/
  installation/
  security/
  control/
  audit/
  runtime/
```

Release directories are immutable and digest-bound. `current` and `previous` are atomic pointers; durable state lives outside both releases.

Updates and rollbacks must never regenerate the bridge identity, delete installation binding/replay/receipt/audit state, embed secrets in release bytes, or silently overwrite the operator environment file.

### Verified bundle

Release Integrity generates a deterministic Linux bundle containing the prebuilt runtime, locked production dependencies, release descriptor, systemd unit, activation/install scripts, environment example and ES/EN operator documentation.

Its SHA-256 is included in `SHA256SUMS` and `release-manifest.json`; on `main`, the Linux bundle receives its own provenance attestation.

### Install

```bash
sudo bash packaging/linux/install-bundle.sh \
  ./agent-bridge-<version>-<commit>-linux-x64.tar.gz \
  <linux-bundle-sha256>
```

The installer verifies the archive before extraction, validates release metadata, installs immutable digest-bound bytes, creates the dedicated technical account, preserves existing config/state and performs systemd daemon reload. It does not automatically start an unenrolled runtime.

### Configure and enroll

Edit `/etc/agent-bridge/agent-bridge.env`. Keep one-time enrollment tokens out of that persistent file. Use a protected temporary token source, run the `enroll` CLI once as the service user, then remove/revoke the token according to the control-plane policy.

### Start and health

```bash
sudo systemctl enable --now agent-bridge.service
sudo systemctl status agent-bridge.service
```

The runtime health probe is local and file/process based; it requires no inbound HTTP endpoint.

### systemd hardening

The baseline unit uses a dedicated user, systemd-managed private state directory, restrictive umask, no-new-privileges, strict filesystem/home/kernel protections, empty Linux capability sets, bounded address families, explicit writable state and controlled SIGTERM shutdown.

`MemoryDenyWriteExecute` is deliberately not enabled by default because Node/V8 JIT behavior may require executable memory. Deployments can add stronger host-specific policy only after workload testing.

### Safe update and rollback

Linux activation reuses the common anti-downgrade release policy and additionally binds every installed release to its exact artifact digest directory. The adapter keeps an exact `previous` pointer, atomically switches `current`, starts the candidate and requires health before success.

If candidate health fails, the adapter restores the exact previous pointer and verifies health. Exit `20` means the candidate failed but exact rollback succeeded; exit `21` means rollback could not be confirmed and the deployment fails closed for operator intervention.

Manual rollback requires the expected previous artifact SHA-256. `finalize` removes only the rollback pointer, never durable state.

# Agent Bridge Docker Deployment / Despliegue Docker de Agent Bridge

## English

### Scope of this slice

The Docker package is the first Phase 6 executable packaging slice for the local/hybrid Agent Bridge runtime.

It currently provides:

- a production CLI with `run`, `enroll`, and `healthcheck` commands;
- persistent Ed25519 bridge identity under the durable state directory;
- persistent installation binding;
- outbound enrollment against Kairoseth Platform;
- outbound authenticated control-session heartbeat;
- runtime connector inventory/health snapshot reporting;
- coordinated session/snapshot lifecycle and graceful SIGTERM/SIGINT shutdown;
- atomic runtime status persistence for container health checks;
- a multi-stage Node.js image running as the non-root `node` user;
- no exposed/listening application port by default;
- a dedicated durable state volume at `/var/lib/agent-bridge`;
- support for running with a read-only root filesystem when the state volume and required secret/config mounts remain writable/readable as appropriate.

This slice does **not** yet mark the complete Docker milestone as finished. Customer connector composition/loading and the installed update/rollback acceptance drill remain Phase 6 work.

### Image security baseline

The Dockerfile uses the official Node.js 22.23.3 Bookworm slim image pinned to its multi-platform digest. The runtime stage:

- runs as `node`, not root;
- declares no `EXPOSE` instruction because the default control path is outbound-only;
- persists mutable runtime state only below `/var/lib/agent-bridge`;
- handles `SIGTERM` as the container stop signal;
- uses the local runtime status file for `HEALTHCHECK` rather than opening a health HTTP endpoint;
- copies only production dependencies and compiled runtime sources from the build stage.

CI builds the image, verifies the non-root user, verifies that no application ports are exposed, verifies that a health check exists, and smoke-loads the production runtime exports.

### Required runtime configuration

`KAB_PLATFORM_BASE_URL` is required for `run` and `enroll`.

Optional variables:

- `KAB_STATE_DIR` — defaults to `/var/lib/agent-bridge`;
- `KAB_DEPLOYMENT_MODE` — `hosted`, `local`, `hybrid`, or `embedded`; defaults to `local`;
- `KAB_ALLOW_INSECURE_HTTP` — defaults to `false`; only use explicit `true`/`1` in a controlled development environment.

HTTPS is required for non-localhost Kairoseth Platform URLs unless the explicit insecure-development opt-in is set.

### Enrollment

Enrollment is a one-time operation per installation/state volume. The preferred container flow is to mount the enrollment token as a read-only secret file instead of baking it into the image.

Example:

```bash
docker volume create agent-bridge-state

docker run --rm \
  --read-only \
  --mount type=volume,src=agent-bridge-state,dst=/var/lib/agent-bridge \
  --mount type=bind,src=/secure/path/enrollment-token,dst=/run/secrets/kab-enrollment-token,readonly \
  -e KAB_PLATFORM_BASE_URL=https://kairoseth.com \
  -e KAB_ENROLLMENT_TOKEN_FILE=/run/secrets/kab-enrollment-token \
  agent-bridge:<version> enroll
```

The token is never persisted by Agent Bridge. The resulting identity and authoritative installation binding are stored in the durable state volume.

### Run

After enrollment:

```bash
docker run --name agent-bridge \
  --restart unless-stopped \
  --read-only \
  --mount type=volume,src=agent-bridge-state,dst=/var/lib/agent-bridge \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
  -e KAB_PLATFORM_BASE_URL=https://kairoseth.com \
  agent-bridge:<version>
```

No inbound port mapping is required for the default control-plane model.

### Health semantics

The runtime writes an atomic status record below the durable state directory. The container health check succeeds only when:

- the state is `ready` or `degraded`;
- the status timestamp is fresh;
- the recorded runtime PID is alive.

`starting`, `stopped`, `failed`, stale, missing, or dead-PID states fail the health check.

A temporary Kairoseth Platform or connector outage can be represented as a recoverable/degraded runtime condition without requiring an inbound health service.

### State boundary

The Docker image is disposable. The state volume is not.

Updates and rollbacks must preserve:

- bridge identity;
- installation binding;
- replay/idempotency state when wired by the deployment adapter;
- durable operational queues when wired by the deployment adapter.

Secrets must remain external to the image and should be provided through the deployment environment or a mounted secret provider.

## Español

### Alcance de este bloque

El paquete Docker es el primer bloque ejecutable de empaquetado de la Fase 6 para el runtime local/híbrido de Agent Bridge.

Actualmente proporciona:

- una CLI de producción con los comandos `run`, `enroll` y `healthcheck`;
- identidad Ed25519 persistente del bridge dentro del directorio de estado duradero;
- binding persistente de la instalación;
- enrolamiento saliente contra Kairoseth Platform;
- heartbeat de sesión de control autenticada y saliente;
- envío de inventario/estado de salud de los conectores;
- ciclo coordinado de sesión/snapshots y apagado limpio con SIGTERM/SIGINT;
- estado de proceso persistido de forma atómica para el healthcheck del contenedor;
- imagen Node.js multi-stage ejecutada con el usuario no-root `node`;
- ningún puerto de aplicación expuesto por defecto;
- volumen de estado duradero dedicado en `/var/lib/agent-bridge`;
- compatibilidad con filesystem raíz de solo lectura si el volumen de estado y los mounts necesarios mantienen los permisos adecuados.

Este bloque **todavía no marca como terminado todo el hito Docker**. La composición/carga de conectores de cliente y la prueba instalada de actualización/rollback siguen pendientes dentro de la Fase 6.

### Base de seguridad de la imagen

El Dockerfile utiliza la imagen oficial Node.js 22.23.3 Bookworm slim fijada por digest multi-plataforma. La etapa de runtime:

- se ejecuta como `node`, no como root;
- no declara `EXPOSE`, porque el control por defecto es exclusivamente saliente;
- mantiene el estado mutable únicamente bajo `/var/lib/agent-bridge`;
- usa `SIGTERM` como señal de parada del contenedor;
- utiliza el fichero local de estado del runtime para `HEALTHCHECK` en lugar de abrir un endpoint HTTP;
- copia únicamente dependencias de producción y fuentes compiladas desde la etapa de build.

CI construye la imagen, comprueba el usuario no-root, verifica que no hay puertos de aplicación expuestos, comprueba la existencia del healthcheck y carga los exports del runtime de producción como smoke test.

### Configuración necesaria

`KAB_PLATFORM_BASE_URL` es obligatoria para `run` y `enroll`.

Variables opcionales:

- `KAB_STATE_DIR` — por defecto `/var/lib/agent-bridge`;
- `KAB_DEPLOYMENT_MODE` — `hosted`, `local`, `hybrid` o `embedded`; por defecto `local`;
- `KAB_ALLOW_INSECURE_HTTP` — por defecto `false`; usar `true`/`1` únicamente de forma explícita en desarrollo controlado.

Se exige HTTPS para URLs de Kairoseth Platform que no sean localhost, salvo opt-in explícito de HTTP inseguro para desarrollo.

### Enrolamiento

El enrolamiento es una operación única por instalación/volumen de estado. El flujo recomendado es montar el token de enrolamiento como secreto de solo lectura en lugar de incluirlo en la imagen.

Ejemplo:

```bash
docker volume create agent-bridge-state

docker run --rm \
  --read-only \
  --mount type=volume,src=agent-bridge-state,dst=/var/lib/agent-bridge \
  --mount type=bind,src=/ruta/segura/enrollment-token,dst=/run/secrets/kab-enrollment-token,readonly \
  -e KAB_PLATFORM_BASE_URL=https://kairoseth.com \
  -e KAB_ENROLLMENT_TOKEN_FILE=/run/secrets/kab-enrollment-token \
  agent-bridge:<version> enroll
```

Agent Bridge no persiste el token. La identidad resultante y el binding autoritativo de instalación se guardan en el volumen de estado duradero.

### Ejecución

Después del enrolamiento:

```bash
docker run --name agent-bridge \
  --restart unless-stopped \
  --read-only \
  --mount type=volume,src=agent-bridge-state,dst=/var/lib/agent-bridge \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
  -e KAB_PLATFORM_BASE_URL=https://kairoseth.com \
  agent-bridge:<version>
```

El modelo de control por defecto no necesita publicar ningún puerto de entrada.

### Semántica del healthcheck

El runtime escribe un registro de estado atómico en el directorio de estado duradero. El healthcheck solo devuelve éxito cuando:

- el estado es `ready` o `degraded`;
- el timestamp sigue siendo reciente;
- el PID registrado del runtime continúa vivo.

Los estados `starting`, `stopped`, `failed`, un registro antiguo/ausente o un PID muerto hacen fallar el healthcheck.

Una interrupción temporal de Kairoseth Platform o de un conector puede representarse como condición recuperable/degradada sin abrir un servicio HTTP entrante.

### Frontera del estado

La imagen Docker es desechable. El volumen de estado no lo es.

Las actualizaciones y rollbacks deben conservar:

- identidad del bridge;
- binding de instalación;
- estado de replay/idempotencia cuando lo conecte el adapter de despliegue;
- colas operativas duraderas cuando las conecte el adapter de despliegue.

Los secretos deben permanecer fuera de la imagen y suministrarse mediante el entorno de despliegue o un proveedor de secretos montado externamente.

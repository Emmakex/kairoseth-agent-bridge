# Runtime operator status / Estado operativo del runtime

## ES

Agent Bridge mantiene un estado local mínimo y sin secretos para que el operador pueda comprobar el proceso sin abrir un puerto HTTP adicional.

### Estado legible para personas

```bash
agent-bridge-runtime status --locale es
```

También se puede fijar el idioma por entorno:

```bash
KAB_OPERATOR_LOCALE=es agent-bridge-runtime status
```

Salida de ejemplo:

```text
Agent Bridge — estado del runtime
Estado: Listo
Salud: Correcta
Versión: 0.1.0-dev.0
PID: 4242
Actualizado: 2026-10-16T08:30:00.000Z
```

La salida solo expone estado, salud derivada, versión del runtime, PID y timestamp. No imprime tokens, credenciales, URLs privadas, configuración de conectores ni payloads.

Idiomas admitidos: `es` y `en`. El flag `--locale` tiene prioridad sobre `KAB_OPERATOR_LOCALE`. Sin configuración explícita, el idioma por defecto es inglés para mantener una salida operativa estable en instalaciones internacionales.

### Healthcheck para automatización

```bash
agent-bridge-runtime healthcheck
```

`healthcheck` no genera texto de operador: devuelve código `0` únicamente cuando el estado durable está fresco, el PID sigue vivo y el runtime está `ready` o `degraded`; en otro caso devuelve `1`.

El comando `status` es informativo y no sustituye el healthcheck de Docker/systemd/monitorización.

### Estado durable

Ambos comandos leen el mismo archivo local:

```text
${KAB_STATE_DIR:-/var/lib/agent-bridge}/runtime/status.json
```

El runtime actualiza ese estado periódicamente y durante transiciones relevantes. La CLI no necesita conexión con Kairoseth Platform para mostrar el último estado local conocido.

---

## EN

Agent Bridge keeps a minimal, secret-free local process status so operators can inspect the runtime without opening an additional HTTP listening port.

### Human-readable status

```bash
agent-bridge-runtime status --locale en
```

The locale can also be selected through the environment:

```bash
KAB_OPERATOR_LOCALE=en agent-bridge-runtime status
```

Example output:

```text
Agent Bridge — runtime status
State: Ready
Health: Healthy
Version: 0.1.0-dev.0
PID: 4242
Updated: 2026-10-16T08:30:00.000Z
```

The output contains only state, derived health, runtime version, PID and timestamp. It never prints tokens, credentials, private URLs, connector configuration or payloads.

Supported locales are `es` and `en`. `--locale` takes precedence over `KAB_OPERATOR_LOCALE`. When neither is provided, English is used as the stable operational default for international installations.

### Automation healthcheck

```bash
agent-bridge-runtime healthcheck
```

`healthcheck` does not emit operator prose. It exits `0` only when the durable status is fresh, the PID is alive and the runtime is `ready` or `degraded`; otherwise it exits `1`.

The `status` command is informational and does not replace Docker/systemd/monitoring health probes.

### Durable status

Both commands read the same local file:

```text
${KAB_STATE_DIR:-/var/lib/agent-bridge}/runtime/status.json
```

The runtime refreshes this state periodically and on relevant transitions. The CLI does not require a live Kairoseth Platform connection to display the last known local status.

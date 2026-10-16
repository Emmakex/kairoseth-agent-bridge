# Windows service deployment / Despliegue como servicio Windows

## ES

Agent Bridge se puede instalar como servicio de Windows x64 manteniendo el mismo modelo de seguridad que Docker/Linux: releases inmutables, configuración y estado fuera del release, rollback exacto por SHA-256 y sin puertos de escucha añadidos por el runtime.

### Requisitos

- Windows 10/11 o Windows Server x64 compatible con Node.js 22+.
- Node.js 22 o superior instalado.
- PowerShell 5.1+ o PowerShell 7+ para instalación/operación.
- Privilegios de Administrador para registrar o cambiar el servicio.
- Acceso HTTPS saliente al control plane configurado en `KAB_PLATFORM_BASE_URL`.

El bundle incorpora **WinSW 2.12.0 x64** exclusivamente como wrapper de Windows Service. El binario queda fijado en CI por SHA-256 `05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da` y se redistribuye con su licencia MIT en `packaging/windows/WINSW-LICENSE.txt`.

### Rutas por defecto

- Releases: `C:\Program Files\Kairoseth\AgentBridge\releases\sha256-<digest>`
- Puntero actual: `C:\Program Files\Kairoseth\AgentBridge\current.txt`
- Puntero rollback: `C:\Program Files\Kairoseth\AgentBridge\previous.txt`
- Configuración: `C:\ProgramData\Kairoseth\AgentBridge\config\agent-bridge.env`
- Estado durable: `C:\ProgramData\Kairoseth\AgentBridge\state`
- Logs del wrapper: `C:\ProgramData\Kairoseth\AgentBridge\logs`

El servicio se ejecuta como `NT AUTHORITY\LocalService`, no como `LocalSystem`. El instalador concede a `LocalService` modificación solo sobre estado/logs y lectura sobre configuración.

### Instalar un bundle verificado

Obtén el SHA-256 del artefacto Windows desde la evidencia de Release Integrity y ejecuta:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\packaging\windows\install-bundle.ps1 `
  .\agent-bridge-<version>-<sha>-windows-x64.zip `
  <sha256-del-zip>
```

El instalador verifica el SHA antes de extraer, rechaza rutas ZIP absolutas/traversal, exige Node.js 22+, valida `runtime-release.json` y coloca el contenido en el directorio inmutable ligado al digest del runtime.

Una segunda instalación **no cambia automáticamente** el release activo. Solo añade el candidato verificado.

### Configurar

Edita el fichero externo `agent-bridge.env`. Como mínimo define un `KAB_PLATFORM_BASE_URL` real y conserva `KAB_STATE_DIR` apuntando al directorio durable externo. Node.js 22 carga este archivo mediante `--env-file`; los secretos no se copian al release ni al XML del servicio.

### Activar con rollback automático

Define la ruta del candidato y, de forma recomendada, los digests esperados:

```powershell
$env:KAB_CANDIDATE_RELEASE_PATH = 'C:\Program Files\Kairoseth\AgentBridge\releases\sha256-...'
$env:KAB_EXPECTED_CURRENT_ARTIFACT_SHA256 = '<digest-actual>'
$env:KAB_EXPECTED_CANDIDATE_ARTIFACT_SHA256 = '<digest-candidato>'

powershell.exe -NoProfile -ExecutionPolicy Bypass -File `
  'C:\Program Files\Kairoseth\AgentBridge\releases\sha256-...\packaging\windows\activate-with-rollback.ps1' activate
```

La activación detiene/desregistra el wrapper anterior, registra el wrapper exacto del candidato, arranca el servicio y ejecuta `healthcheck`. Si el candidato no queda saludable, se restaura exactamente el release anterior y el script devuelve código `20`. Si tampoco puede restaurarlo, devuelve `21` y falla cerrado.

### Rollback manual

Mientras exista `previous.txt`:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\activate-with-rollback.ps1 rollback
```

### Finalizar una actualización

Cuando el candidato ya está aceptado:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\activate-with-rollback.ps1 finalize
```

Esto elimina solo el puntero de rollback. No borra configuración ni estado durable.

### Estado operativo ES/EN

```powershell
node .\dist\src\cli\agent-bridge-runtime.js status --locale es
node .\dist\src\cli\agent-bridge-runtime.js status --locale en
```

`healthcheck` sigue reservado para automatización y códigos de salida.

## EN

Agent Bridge can be installed as an x64 Windows service while preserving the Docker/Linux security model: immutable releases, configuration and durable state outside release directories, exact SHA-256 rollback, and no new runtime listening port.

### Requirements

- Windows 10/11 or Windows Server x64 supported by Node.js 22+.
- Node.js 22 or newer installed.
- PowerShell 5.1+ or PowerShell 7+ for installation/operations.
- Administrator privileges to register or replace the service.
- Outbound HTTPS access to the configured Kairoseth control plane.

The bundle includes **WinSW 2.12.0 x64** only as the Windows Service wrapper. CI pins the binary to SHA-256 `05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da`; its MIT license is shipped as `packaging/windows/WINSW-LICENSE.txt`.

### Default paths

- Releases: `C:\Program Files\Kairoseth\AgentBridge\releases\sha256-<digest>`
- Current pointer: `C:\Program Files\Kairoseth\AgentBridge\current.txt`
- Rollback pointer: `C:\Program Files\Kairoseth\AgentBridge\previous.txt`
- Configuration: `C:\ProgramData\Kairoseth\AgentBridge\config\agent-bridge.env`
- Durable state: `C:\ProgramData\Kairoseth\AgentBridge\state`
- Wrapper logs: `C:\ProgramData\Kairoseth\AgentBridge\logs`

The service runs as `NT AUTHORITY\LocalService`, not LocalSystem. The installer grants LocalService modify access only to state/log directories and read access to configuration.

### Install a verified bundle

Take the Windows artifact SHA-256 from Release Integrity evidence and run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\packaging\windows\install-bundle.ps1 `
  .\agent-bridge-<version>-<sha>-windows-x64.zip `
  <zip-sha256>
```

The installer verifies SHA-256 before extraction, rejects absolute/traversal ZIP paths, requires Node.js 22+, validates `runtime-release.json`, and installs bytes into the digest-bound immutable release directory.

Installing a second release does **not** silently switch the active runtime. It only stages the verified candidate.

### Configure

Edit the external `agent-bridge.env` file. Set a real `KAB_PLATFORM_BASE_URL` and keep `KAB_STATE_DIR` on the external durable state directory. Node.js 22 reads this file through `--env-file`; secret values are not copied into the immutable release or service XML.

### Activate with automatic rollback

Set the candidate path and preferably both expected digests, then run `activate-with-rollback.ps1 activate`. Activation stops/unregisters the previous wrapper, installs the candidate's exact wrapper, starts the service and runs `healthcheck`. A failed candidate restores the exact previous release and returns exit code `20`; failure to restore returns `21` and remains fail-closed.

### Manual rollback / finalize

Use `rollback` while `previous.txt` exists. Use `finalize` after accepting the update. Finalization removes only the rollback pointer and never deletes operator configuration or durable state.

### ES/EN operator status

```powershell
node .\dist\src\cli\agent-bridge-runtime.js status --locale es
node .\dist\src\cli\agent-bridge-runtime.js status --locale en
```

`healthcheck` remains an automation-only exit-code surface.

# Files Connector / Conector Files

## ES

El conector oficial Files permite a Kairoseth Agent Bridge trabajar con archivos locales o montados **únicamente dentro de roots declarados por el despliegue**. El agente nunca proporciona una ruta absoluta del sistema.

### Modelo de roots

Cada root declara:

- ID técnico estable;
- ruta absoluta controlada por deployment;
- nombre y descripción canónicos;
- nombre y descripción ES/EN;
- nivel de acceso `read`, `write` o `full`;
- límite máximo de lectura;
- límite máximo de escritura;
- allowlist opcional de extensiones;
- permiso opcional para dotfiles.

Los niveles generan estas tools:

| Access | Tools | Riesgo |
| --- | --- | --- |
| `read` | `list`, `read` | READ |
| `write` | `list`, `read`, `write` | READ / WRITE |
| `full` | `list`, `read`, `write`, `delete`, `move` | READ / WRITE / CRITICAL |

Ejemplo de IDs runtime:

```text
files.<instanceId>.documents.list
files.<instanceId>.documents.read
files.<instanceId>.documents.write
files.<instanceId>.documents.delete
files.<instanceId>.documents.move
```

La ruta absoluta del root no se publica en manifest, MCP discovery ni inputs del agente.

### Paths relativos

Las tools aceptan únicamente paths relativos portables con `/`.

Se rechazan antes de tocar el filesystem:

- rutas absolutas;
- segmentos `..` o `.`;
- segmentos vacíos;
- backslashes;
- `:` para evitar semánticas alternativas como NTFS ADS;
- caracteres de control;
- paths superiores al límite configurado por el conector.

Los dotfiles y directorios con prefijo `.` están bloqueados por defecto. Un root puede habilitarlos explícitamente mediante `allowDotFiles`.

### Protección frente a symlinks

El conector no sigue symlinks aportados desde un path del agente:

- canonicaliza el root confiable;
- usa `lstat` sobre cada segmento existente;
- rechaza cualquier segmento simbólico;
- rechaza targets finales simbólicos;
- usa `O_NOFOLLOW` en la apertura final cuando el sistema operativo lo ofrece.

`delete` y `move` solo operan sobre ficheros regulares. No eliminan ni mueven directorios o symlinks.

Esta combinación reduce escapes del root y ataques de path traversal. El hardening adicional frente a carreras de filesystem/TOCTOU en plataformas heterogéneas pertenece a la fase de production hardening.

### `list` — READ

Lista un directorio dentro del root y devuelve entradas normalizadas:

```json
{
  "entries": [
    {
      "name": "invoice.txt",
      "path": "2026/invoice.txt",
      "type": "file"
    }
  ],
  "total": 1
}
```

- paginación mediante `offset`/`limit`;
- máximo 500 entradas por llamada;
- dotfiles ocultos por defecto;
- si existe `allowedExtensions`, los ficheros fuera de la allowlist no se listan.

### `read` — READ

Lee un único fichero regular y acotado.

Inputs:

- `path` relativo;
- `encoding`: `utf8` o `base64`.

Devuelve:

- path relativo;
- tamaño en bytes;
- encoding;
- contenido;
- SHA-256.

La lectura valida tamaño antes y después de leer. El default es 1 MiB y el hard cap del conector es 10 MiB por fichero.

### `write` — WRITE

Crea o actualiza un fichero regular dentro de un root `write`/`full`.

Inputs:

- `path` relativo;
- `content`;
- `encoding`: `utf8` o `base64`;
- `overwrite`, `false` por defecto.

Reglas:

- si el fichero existe, `overwrite: true` es obligatorio;
- el contenido base64 se valida estrictamente;
- el tamaño se valida antes de escribir;
- los nuevos ficheros se crean con modo `0600` donde la plataforma respeta permisos POSIX;
- se solicita `fsync` antes de cerrar el handle;
- un target simbólico se rechaza.

La tool es WRITE y con secure-default policy devuelve `approval_required` antes de realizar la mutación. Declara `retry: never`.

### `delete` — CRITICAL

Elimina un único fichero regular de un root `full`.

No elimina directorios ni symlinks. Al ser CRITICAL requiere aprobación bajo la policy segura y nunca se reintenta automáticamente.

### `move` — CRITICAL

Mueve un fichero regular a otro path **dentro del mismo root**.

- source y destination deben ser distintos;
- el parent de destino debe existir y no contener symlinks;
- si el destino existe, `overwrite: true` debe ser explícito;
- no existe move entre roots mediante esta tool.

Está clasificada CRITICAL y declara `retry: never`.

### Extensiones permitidas

Un root puede declarar, por ejemplo:

```ts
allowedExtensions: [".txt", ".json", ".csv"]
```

La allowlist se aplica a lectura, escritura, delete/move y al filtrado de ficheros en list. Los directorios siguen siendo navegables dentro del root.

### Approvals y retry

- `list` / `read`: READ, con retry únicamente para errores transitorios de filesystem reconocidos;
- `write`: WRITE, approval requerido por secure-default policy, sin retry automático;
- `delete` / `move`: CRITICAL, approval requerido, sin retry automático.

Todo sigue pasando por `BridgeRuntime`, policy y audit.

### ES/EN

El conector y cada root exigen metadata ES/EN. Los IDs técnicos, paths relativos, hashes y decisiones de seguridad permanecen independientes del idioma.

---

## EN

The official Files connector lets Kairoseth Agent Bridge work with local or mounted files **only inside deployment-declared roots**. Agents never supply an operating-system absolute path.

### Root model

Each root declares:

- stable technical ID;
- deployment-controlled absolute path;
- canonical name and description;
- ES and EN name/description;
- `read`, `write` or `full` access;
- maximum read size;
- maximum write size;
- optional extension allowlist;
- optional dotfile access.

Access generates these tools:

| Access | Tools | Risk |
| --- | --- | --- |
| `read` | `list`, `read` | READ |
| `write` | `list`, `read`, `write` | READ / WRITE |
| `full` | `list`, `read`, `write`, `delete`, `move` | READ / WRITE / CRITICAL |

Example runtime IDs:

```text
files.<instanceId>.documents.list
files.<instanceId>.documents.read
files.<instanceId>.documents.write
files.<instanceId>.documents.delete
files.<instanceId>.documents.move
```

The absolute root path is never published in manifests, MCP discovery or agent inputs.

### Relative paths

Tools accept only portable relative paths using `/`.

The connector rejects before filesystem access:

- absolute paths;
- `..` or `.` segments;
- empty segments;
- backslashes;
- `:` to avoid alternate semantics such as NTFS ADS;
- control characters;
- paths beyond the connector path-length bound.

Dotfiles and dot-prefixed directories are blocked by default. A root may explicitly enable them with `allowDotFiles`.

### Symlink protection

The connector does not follow symlinks supplied through agent paths:

- canonicalizes the trusted root;
- uses `lstat` on each existing segment;
- rejects symbolic path segments;
- rejects symbolic final targets;
- uses `O_NOFOLLOW` for final opens when supported by the operating system.

`delete` and `move` operate only on regular files. They do not remove or move directories or symlinks.

This combination reduces root escapes and path-traversal attacks. Additional cross-platform filesystem race/TOCTOU hardening belongs to production hardening.

### `list` — READ

Lists one directory inside the root and returns normalized entries:

```json
{
  "entries": [
    {
      "name": "invoice.txt",
      "path": "2026/invoice.txt",
      "type": "file"
    }
  ],
  "total": 1
}
```

- `offset`/`limit` pagination;
- at most 500 entries per call;
- dotfiles hidden by default;
- when `allowedExtensions` exists, non-allowlisted files are omitted.

### `read` — READ

Reads one bounded regular file.

Inputs:

- relative `path`;
- `encoding`: `utf8` or `base64`.

Returns:

- relative path;
- byte size;
- encoding;
- content;
- SHA-256.

Size is checked before and after reading. Default is 1 MiB and the connector hard cap is 10 MiB per file.

### `write` — WRITE

Creates or updates one regular file inside a `write`/`full` root.

Inputs:

- relative `path`;
- `content`;
- `encoding`: `utf8` or `base64`;
- `overwrite`, default `false`.

Rules:

- existing files require explicit `overwrite: true`;
- base64 content is strictly validated;
- size is checked before writing;
- new files use mode `0600` where POSIX permissions apply;
- the handle is `fsync`ed before close;
- symbolic targets are rejected.

The tool is WRITE and returns `approval_required` under secure-default policy before mutation. It declares `retry: never`.

### `delete` — CRITICAL

Deletes one regular file from a `full` root.

It does not delete directories or symlinks. As a CRITICAL tool it requires approval under secure-default policy and is never automatically retried.

### `move` — CRITICAL

Moves one regular file to another path **within the same root**.

- source and destination must differ;
- destination parents must already exist and contain no symlinks;
- existing destinations require explicit `overwrite: true`;
- this tool cannot move between roots.

It is classified CRITICAL and declares `retry: never`.

### Allowed extensions

A root may declare, for example:

```ts
allowedExtensions: [".txt", ".json", ".csv"]
```

The allowlist applies to read, write, delete/move and file filtering during list. Directories remain navigable within the root.

### Approvals and retry

- `list` / `read`: READ, retry only recognized transient filesystem failures;
- `write`: WRITE, approval required by secure-default policy, no automatic retry;
- `delete` / `move`: CRITICAL, approval required, no automatic retry.

All execution still flows through `BridgeRuntime`, policy and audit.

### ES/EN

The connector and every root require ES/EN metadata. Technical IDs, relative paths, hashes and security decisions remain locale-independent.

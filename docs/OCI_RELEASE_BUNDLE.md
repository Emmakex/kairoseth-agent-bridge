# Agent Bridge — OCI release bundle / bundle de release OCI

## ES

### Objetivo

El packaging Docker de producción debe estar ligado al mismo código de aplicación que ya pasó el gate de Release Integrity. No se acepta una segunda compilación TypeScript independiente dentro de la imagen de release.

La cadena es:

```text
source commit
  -> npm ci
  -> npm run check
  -> dist/src verificado
       ├── runtime archive determinista
       └── OCI release image
```

`packaging/docker/Dockerfile.release` consume `dist/src` ya compilado. Solo instala las dependencias de producción fijadas por `package-lock.json`; no contiene `tsc`, no copia `src/` y no vuelve a compilar la aplicación.

### Identidades separadas

El bundle conserva tres identificadores que no deben confundirse:

1. `artifact.sha256`: SHA-256 del tar de runtime;
2. `ociImage.archiveSha256`: SHA-256 del archivo tar que contiene el OCI image layout;
3. `ociImage.manifestDigest`: digest `sha256:` del manifiesto de imagen OCI producido por BuildKit.

El adapter de rollback instalado utiliza además el Docker image ID local después de importar/materializar una imagen. Ese image ID es una identidad de instalación y no sustituye ninguno de los hashes anteriores.

### Build reproducible

La imagen de release usa:

- base Node 22.23.3 fijada por digest;
- `package-lock.json` + `npm ci --omit=dev`;
- `SOURCE_DATE_EPOCH` derivado del commit;
- un único target `linux/amd64` en este baseline;
- OCI exporter de Buildx;
- provenance interna de BuildKit desactivada para evitar metadata variable dentro del archive; la provenance oficial se añade externamente mediante `actions/attest`.

La reproducibilidad bit-a-bit del OCI archive debe probarse explícitamente antes de declararla como garantía contractual. En esta fase se registra y verifica el SHA exacto generado en cada release.

### Release manifest

`release-manifest.json` mantiene la evidencia del runtime y añade:

```json
{
  "ociImage": {
    "format": "OCI image layout tar",
    "file": "agent-bridge-...oci.tar",
    "archiveSha256": "...",
    "manifestDigest": "sha256:...",
    "platform": "linux/amd64",
    "applicationBuildSource": "release/stage prebuilt dist/src"
  }
}
```

`SHA256SUMS` incluye tanto el tar de runtime como el OCI archive y el SBOM de dependencias de aplicación.

### Attestations

En `main` / `workflow_dispatch` el workflow produce:

- SLSA provenance del runtime archive;
- SLSA provenance separada del OCI archive;
- CycloneDX SBOM attestation del runtime archive para dependencias de aplicación.

El SBOM actual está etiquetado con alcance `application-dependencies`. No se presenta como un SBOM completo del sistema operativo de la imagen.

Un SBOM OCI/OS completo y la promoción a un registry con digest de distribución estable siguen siendo trabajos separados antes de una release estable pública.

### Gate antes del merge

`Release Integrity` también se ejecuta en pull requests que afectan al runtime o packaging. En PR:

- compila y prueba el source tree;
- genera runtime archive;
- genera OCI archive;
- valida todos los checksums;
- **no** emite attestations ni publica el release bundle.

Las attestations y el upload ocurren únicamente después de entrar en `main` o mediante `workflow_dispatch` autorizado.

Esto evita descubrir un error de Buildx/OCI solo después de fusionar.

---

## EN

### Goal

Production Docker packaging must be bound to the same application build that already passed the Release Integrity gate. A second independent TypeScript compilation inside the release image is not accepted.

The chain is:

```text
source commit
  -> npm ci
  -> npm run check
  -> verified dist/src
       ├── deterministic runtime archive
       └── OCI release image
```

`packaging/docker/Dockerfile.release` consumes the already-built `dist/src`. It installs only production dependencies pinned by `package-lock.json`; it does not contain `tsc`, copy `src/`, or compile the application again.

### Separate identities

The release bundle preserves three distinct identifiers:

1. `artifact.sha256`: SHA-256 of the runtime tar archive;
2. `ociImage.archiveSha256`: SHA-256 of the OCI image-layout tar archive;
3. `ociImage.manifestDigest`: the `sha256:` OCI image manifest digest produced by BuildKit.

The installed rollback adapter additionally uses the local Docker image ID after an image is materialized. That installation identity does not replace any of the release hashes above.

### Reproducible build inputs

The release image uses a Node 22.23.3 base pinned by digest, locked production dependencies, `SOURCE_DATE_EPOCH` derived from the commit, a single `linux/amd64` baseline platform, and the Buildx OCI exporter.

BuildKit-internal provenance is disabled inside the archive; official provenance is attached externally with `actions/attest`.

Bit-for-bit OCI archive reproducibility must be demonstrated explicitly before it becomes a contractual guarantee. This phase records and verifies the exact archive SHA produced for every release.

### Release manifest

`release-manifest.json` adds an `ociImage` section containing the OCI archive filename, archive SHA-256, manifest digest, platform, and evidence that the application layer came from the prebuilt release-stage `dist/src`.

`SHA256SUMS` covers the runtime archive, OCI archive, and application-dependency SBOM.

### Attestations

On `main` or authorized `workflow_dispatch`, Release Integrity creates separate SLSA provenance for the runtime archive and OCI archive, plus the CycloneDX application-dependency SBOM attestation bound to the runtime archive.

The current CycloneDX document is explicitly scoped to application dependencies. It is not claimed to be a complete operating-system/container-image SBOM.

A full OCI/OS SBOM and registry promotion under a stable distribution digest remain separate work before a public stable release.

### Pre-merge gate

Release Integrity also runs on pull requests that change runtime or packaging. Pull-request runs compile/test the source tree, generate both archives, and verify checksums, but do not emit attestations or upload a release bundle.

Attestation and publication happen only after the change reaches `main` or through authorized `workflow_dispatch`, so OCI packaging failures are caught before merge.

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
       └── OCI release image + image SBOM
```

`packaging/docker/Dockerfile.release` consume `dist/src` ya compilado. Solo instala las dependencias de producción fijadas por `package-lock.json`; no contiene `tsc`, no copia `src/` y no vuelve a compilar la aplicación.

### Identidades separadas

El bundle conserva identidades distintas que no deben confundirse:

1. `artifact.sha256`: SHA-256 del tar de runtime;
2. `ociImage.archiveSha256`: SHA-256 del archivo tar que contiene el OCI image layout;
3. `ociImage.exportDigest`: digest del índice/export OCI producido por BuildKit;
4. `ociImage.manifestDigest`: digest del manifiesto de plataforma `linux/amd64` realmente ejecutable;
5. `ociImage.sbom.sha256`: SHA-256 del SPDX extraído y publicado como evidencia independiente.

El adapter de rollback instalado utiliza además el Docker image ID local después de importar/materializar una imagen. Ese image ID es una identidad de instalación y no sustituye ninguno de los hashes anteriores.

### Build reproducible

La imagen de release usa:

- base Node 22.23.3 fijada por digest;
- `package-lock.json` + `npm ci --omit=dev`;
- `SOURCE_DATE_EPOCH` derivado del commit y pasado explícitamente como build argument;
- un único target `linux/amd64` en este baseline;
- OCI exporter de Buildx;
- provenance interna de BuildKit desactivada para evitar metadata variable dentro del archive;
- SBOM BuildKit habilitado para la imagen;
- provenance oficial externa mediante `actions/attest`.

La reproducibilidad bit-a-bit del OCI archive debe probarse explícitamente antes de declararla como garantía contractual. En esta fase se registra y verifica el SHA exacto generado en cada release.

### Dos SBOM, dos alcances

El release mantiene deliberadamente dos documentos:

#### CycloneDX de aplicación

`sbom.cdx.json` se genera con npm y tiene alcance:

```text
application-dependencies
```

Está ligado al runtime archive y describe las dependencias Node de la aplicación.

#### SPDX de imagen OCI

BuildKit genera una attestation SBOM para la imagen. `scripts/extract-oci-sbom.mjs` valida el OCI image layout antes de extraerla:

1. exige exactamente un manifiesto `linux/amd64`;
2. encuentra exactamente una attestation manifest cuyo `vnd.docker.reference.digest` apunta a ese manifiesto;
3. encuentra exactamente un layer cuyo predicate type es `https://spdx.dev/Document`;
4. valida que el in-toto statement tiene como subject el SHA-256 del manifiesto de plataforma;
5. valida `SPDX-*` y que existen paquetes;
6. publica solo el `predicate` SPDX como `oci-sbom.spdx.json`.

El manifest registra además:

- digest del attestation manifest;
- digest del blob SBOM dentro del OCI layout;
- número de paquetes encontrados.

Esto evita aceptar un SBOM presente en el archive pero no ligado a la imagen que realmente se ejecutaría.

### Release manifest

`release-manifest.json` mantiene la evidencia del runtime y añade una forma equivalente a:

```json
{
  "ociImage": {
    "format": "OCI image layout tar",
    "file": "agent-bridge-...oci.tar",
    "archiveSha256": "...",
    "exportDigest": "sha256:...",
    "manifestDigest": "sha256:...",
    "platform": "linux/amd64",
    "applicationBuildSource": "release/stage prebuilt dist/src",
    "sbom": {
      "format": "SPDX",
      "file": "oci-sbom.spdx.json",
      "sha256": "...",
      "scope": "container-image",
      "subjectManifestDigest": "sha256:...",
      "attestationManifestDigest": "sha256:...",
      "sbomBlobDigest": "sha256:...",
      "packageCount": 1
    }
  }
}
```

`SHA256SUMS` incluye el tar de runtime, el OCI archive, el CycloneDX de aplicación y el SPDX de imagen.

### Attestations

En `main` / `workflow_dispatch` el workflow produce:

- SLSA provenance del runtime archive;
- SLSA provenance separada del OCI archive;
- SPDX image-SBOM attestation ligada al OCI archive;
- CycloneDX application-SBOM attestation ligada al runtime archive.

Además, el propio OCI layout conserva la attestation SBOM generada por BuildKit ligada al manifest de plataforma. Por tanto existe evidencia tanto dentro del formato OCI como en la cadena de attestations externa de GitHub/Sigstore.

### Gate antes del merge

`Release Integrity` también se ejecuta en pull requests que afectan al runtime, scripts de release o packaging. En PR:

- compila y prueba el source tree;
- genera runtime archive;
- genera OCI archive con SBOM embebido;
- extrae y valida el SPDX contra el manifest de plataforma;
- valida todos los checksums;
- **no** emite attestations externas ni publica el release bundle.

Las attestations externas y el upload ocurren únicamente después de entrar en `main` o mediante `workflow_dispatch` autorizado.

Esto evita descubrir un error de Buildx/OCI/SBOM solo después de fusionar.

### Lo que sigue abierto

La evidencia de archivo OCI y SBOM de imagen no equivale todavía a una promoción pública estable. Permanecen separados:

- política de tag/version estable;
- promoción a registry bajo digest de distribución;
- verificación del digest después del push;
- política de retención/promoción/rollback del registry;
- release estable formal.

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
       └── OCI release image + image SBOM
```

`packaging/docker/Dockerfile.release` consumes the already-built `dist/src`. It installs only production dependencies pinned by `package-lock.json`; it does not contain `tsc`, copy `src/`, or compile the application again.

### Separate identities

The release bundle preserves distinct identifiers:

1. `artifact.sha256`: SHA-256 of the runtime tar archive;
2. `ociImage.archiveSha256`: SHA-256 of the OCI image-layout tar archive;
3. `ociImage.exportDigest`: digest of the OCI index/export emitted by BuildKit;
4. `ociImage.manifestDigest`: digest of the runnable `linux/amd64` platform manifest;
5. `ociImage.sbom.sha256`: SHA-256 of the extracted standalone SPDX evidence.

The installed rollback adapter additionally uses the local Docker image ID after an image is materialized. That installation identity does not replace any release identity above.

### Reproducible build inputs

The release image uses a Node 22.23.3 base pinned by digest, locked production dependencies, `SOURCE_DATE_EPOCH` derived from the commit and explicitly passed as a build argument, a single `linux/amd64` baseline platform, and the Buildx OCI exporter.

BuildKit-internal provenance is disabled inside the archive, BuildKit image SBOM generation is enabled, and official provenance is attached externally with `actions/attest`.

Bit-for-bit OCI archive reproducibility must still be demonstrated explicitly before it becomes a contractual guarantee. This phase records and verifies the exact archive SHA produced for every release.

### Two SBOMs, two scopes

The release deliberately carries two documents.

#### Application CycloneDX

`sbom.cdx.json` is generated from npm with scope `application-dependencies`. It is bound to the runtime archive and describes Node application dependencies.

#### OCI image SPDX

BuildKit emits an image SBOM attestation. `scripts/extract-oci-sbom.mjs` validates the OCI layout before extracting it:

1. require exactly one `linux/amd64` image manifest;
2. require exactly one attestation manifest referencing that image manifest;
3. require exactly one `https://spdx.dev/Document` layer;
4. require the in-toto subject SHA-256 to match the platform image manifest;
5. validate an `SPDX-*` document with a non-empty package list;
6. publish only the SPDX predicate as `oci-sbom.spdx.json`.

The release manifest also records the attestation-manifest digest, internal SBOM blob digest, and package count. An unrelated SBOM merely present in the archive is therefore not accepted as evidence for the runnable image.

### Release manifest

`release-manifest.json` records the OCI archive, export/index digest, runnable platform manifest digest, source of the prebuilt application tree, and a nested image-SBOM evidence block with hashes and binding metadata.

`SHA256SUMS` covers the runtime archive, OCI archive, application CycloneDX, and image SPDX.

### Attestations

On `main` or authorized `workflow_dispatch`, Release Integrity creates:

- SLSA provenance for the runtime archive;
- separate SLSA provenance for the OCI archive;
- SPDX image-SBOM attestation bound to the OCI archive;
- CycloneDX application-SBOM attestation bound to the runtime archive.

The OCI layout itself also retains the BuildKit-generated SBOM attestation bound to the platform manifest, providing both OCI-native evidence and external GitHub/Sigstore evidence.

### Pre-merge gate

Release Integrity also runs on pull requests that change runtime, release scripts, or packaging. Pull-request runs compile/test source, generate both archives, extract and validate the image SPDX against the platform manifest, and verify all checksums, but do not emit external attestations or upload a release bundle.

External attestation and publication happen only after the change reaches `main` or through authorized `workflow_dispatch`.

### Still open

OCI archive evidence and an image SBOM do not yet equal stable public promotion. Stable version/tag policy, registry promotion under a distribution digest, post-push digest verification, registry retention/rollback policy, and formal stable release promotion remain separate work.

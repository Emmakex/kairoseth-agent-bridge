# Agent Bridge — release integrity / integridad de release

## ES

### Estado validado

`Release Integrity` construye artefactos reproducibles y verificables para la identidad técnica estable `agent-bridge`. La cadena no cambia el nombre comercial: **Integración de agentes de IA** en ES y **AI Integration** en EN.

La primera ejecución de provenance/SBOM validada corresponde al commit `397d7b7536db581caa6701f64f412d0db3d35ac3`. Desde entonces la cadena se ha ampliado sin reemplazar aquella evidencia base.

Actualmente el mismo workflow valida primero `npm ci` + typecheck + tests + build y después genera superficies de distribución diferentes a partir del runtime ya compilado:

1. archive runtime genérico determinista;
2. bundle Linux/systemd determinista con dependencias de producción bloqueadas por `package-lock.json`;
3. archive OCI de la imagen Docker construida desde el mismo `dist/src` precompilado;
4. SBOM CycloneDX de dependencias de aplicación;
5. SBOM SPDX de la imagen OCI completa, incluido el inventario del filesystem/base image que expone BuildKit.

### Runtime archive

El archive genérico contiene:

- `dist/src`;
- `package.json`;
- `package-lock.json`;
- `README.md`.

Se empaqueta con orden estable, timestamp normalizado, propietario/grupo numéricos normalizados y gzip sin timestamp variable. Su SHA-256 se registra en `SHA256SUMS` y `release-manifest.json`.

En la primera ejecución validada:

- SHA-256 runtime: `7ac7dc4a6bbe3bf15515da1ab9c347c0a0b6680343507b3f0a6041ceeb82f712`;
- SHA-256 SBOM CycloneDX: `a5076367e69ee5cfd7870ea212ced010e44892f675e753037ace9302bb0f550d`.

Los hashes se verificaron nuevamente tras descargar el artifact publicado por GitHub Actions.

### OCI / Docker

La imagen de release no recompila TypeScript. `packaging/docker/Dockerfile.release` consume el `dist/src` previamente verificado e instala dependencias de producción desde el lockfile.

Release Integrity exporta un OCI image layout y registra separadamente:

- SHA-256 del archivo OCI exportado;
- digest del manifest ejecutable `linux/amd64`;
- digest del manifest de attestation BuildKit;
- digest del blob SPDX;
- SHA-256 del documento `oci-sbom.spdx.json`;
- número de packages del SBOM.

La imagen y el runtime genérico no se presentan como el mismo byte artifact: cada uno tiene identidad/digest y provenance propios.

### Linux/systemd

El bundle Linux se genera desde el mismo `dist/src` verificado. No recompila la aplicación en el host y contiene:

- runtime precompilado;
- dependencias de producción instaladas con `npm ci --omit=dev` y el lockfile de la release;
- `runtime-release.json`;
- unidad systemd endurecida;
- instalador y adaptador de activación/rollback;
- configuración de ejemplo y documentación ES/EN.

`runtime-release.json` enlaza el bundle con el SHA-256 del runtime archive genérico. La instalación final usa un directorio inmutable `sha256-<runtime-artifact-sha256>`. El bundle Linux obtiene su propio SHA-256, entrada de manifest y provenance attestation; no se confunde su digest externo con el digest del runtime que identifica la release instalada.

### Atestaciones

En `main`, `actions/attest@v4` produce evidencia independiente para las superficies publicadas:

- SLSA build provenance del runtime archive;
- SLSA build provenance del bundle Linux/systemd;
- SLSA build provenance del archive OCI;
- SBOM CycloneDX ligado al runtime archive;
- SBOM SPDX de imagen ligado al archive OCI.

La firma usa la identidad OIDC del workflow y certificados Sigstore de corta duración; el repositorio no introduce una clave privada de firma de larga duración.

### Checksum y manifest

`SHA256SUMS` cubre todos los archivos descargables que requieren verificación local. `release-manifest.json` registra versión, commit fuente, runtime artifact, bundle Linux, OCI image, SBOMs y metadatos de build.

El workflow ejecuta `sha256sum --check` sobre el conjunto antes de emitir attestations o publicar el bundle.

### Promoción y rollback

La instalación/update no permite reinterpretar una versión existente con bytes diferentes. La política común:

- rechaza colisiones versión/digest;
- bloquea downgrades arbitrarios;
- requiere opt-in para candidates;
- permite rollback solo al descriptor exacto de la release previa confiable.

Docker añade la identidad exacta de imagen; Linux añade la ruta digest-bound exacta. Ambos tienen drills instalados de rollback con estado durable externo al release.

### Frontera que sigue abierta

La cadena de candidate artifacts, OCI evidence, SBOMs, Docker rollback y Linux packaging no equivale aún a una política formal de **stable promotion**. Permanecen separados:

- tag/version estable y GitHub Release/registry promotion;
- política de firma/promoción de una release marcada `stable`;
- Windows Service packaging;
- durable/clustered A2A task storage;
- observabilidad y superficies de operador en Kairoseth Platform.

Una promoción estable debe reutilizar los bytes y digests ya verificados; no debe recompilar una versión bajo el mismo identificador.

---

## EN

### Validated state

`Release Integrity` builds reproducible, verifiable artifacts for the stable technical identity `agent-bridge`. Distribution does not change the commercial names: **Integración de agentes de IA** in ES and **AI Integration** in EN.

The first validated provenance/SBOM run corresponds to commit `397d7b7536db581caa6701f64f412d0db3d35ac3`. The supply-chain workflow has since expanded while retaining that original baseline evidence.

The workflow now validates `npm ci` + typecheck + tests + build first, then creates multiple distribution surfaces from the already-built runtime:

1. deterministic generic runtime archive;
2. deterministic Linux/systemd bundle with production dependencies locked by `package-lock.json`;
3. OCI Docker image archive built from the same prebuilt `dist/src`;
4. CycloneDX application dependency SBOM;
5. full OCI image SPDX SBOM, including the base/filesystem inventory exposed by BuildKit.

### Runtime archive

The generic archive contains `dist/src`, `package.json`, `package-lock.json`, and `README.md`. Packaging uses stable ordering, normalized timestamps and numeric ownership plus deterministic gzip metadata. Its SHA-256 is recorded in both `SHA256SUMS` and `release-manifest.json`.

For the first validated run:

- runtime SHA-256: `7ac7dc4a6bbe3bf15515da1ab9c347c0a0b6680343507b3f0a6041ceeb82f712`;
- CycloneDX SBOM SHA-256: `a5076367e69ee5cfd7870ea212ced010e44892f675e753037ace9302bb0f550d`.

Those hashes were independently checked again after downloading the published GitHub Actions artifact.

### OCI / Docker

The release image does not rebuild application TypeScript. `packaging/docker/Dockerfile.release` consumes the verified prebuilt `dist/src` and installs production dependencies from the committed lockfile.

Release Integrity exports an OCI image layout and records the OCI archive SHA-256, runnable `linux/amd64` manifest digest, BuildKit attestation manifest digest, SPDX blob digest, standalone `oci-sbom.spdx.json` SHA-256, and package count.

The OCI image and generic runtime archive are explicitly different byte artifacts; each receives its own identity/digest and provenance evidence.

### Linux/systemd

The Linux service bundle also consumes the verified prebuilt `dist/src`. It contains locked production dependencies, `runtime-release.json`, the hardened systemd unit, install/activation/rollback adapters, environment example, and ES/EN operator documentation.

`runtime-release.json` binds the installed release to the generic runtime archive SHA-256. Installed bytes live under the immutable `sha256-<runtime-artifact-sha256>` directory. The outer Linux bundle has its own SHA-256, manifest entry, and provenance attestation and is never substituted for the installed runtime release identity.

### Attestations

On `main`, `actions/attest@v4` emits independent evidence for the distributed surfaces:

- SLSA build provenance for the generic runtime archive;
- SLSA build provenance for the Linux/systemd bundle;
- SLSA build provenance for the OCI archive;
- CycloneDX SBOM attestation bound to the runtime archive;
- SPDX image SBOM attestation bound to the OCI archive.

Signing uses workflow OIDC identity and short-lived Sigstore certificates, so no long-lived release signing private key is stored in the repository.

### Checksums and manifest

`SHA256SUMS` covers locally verifiable downloadable files. `release-manifest.json` records the source version/commit plus generic runtime, Linux bundle, OCI image, SBOM, and build evidence. The workflow runs `sha256sum --check` before attestations or publication.

### Promotion and rollback

The common update policy rejects version/digest collisions, blocks arbitrary downgrade, requires explicit candidate opt-in, and permits rollback only to the exact trusted previous descriptor. Docker additionally binds activation to an immutable image ID; Linux binds activation to an immutable digest-named release directory. Both paths have installed rollback drills with durable state outside the release bytes.

### Remaining boundary

Candidate artifacts, OCI evidence, SBOMs, installed Docker rollback, and Linux packaging are not yet a formal **stable promotion** policy. Stable tag/version and registry/GitHub Release promotion, Windows Service packaging, durable clustered A2A task storage, and Platform observability/operator surfaces remain separate work.

Stable promotion must reuse already-verified bytes and digests rather than rebuilding different content under the same version.

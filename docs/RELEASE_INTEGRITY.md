# Agent Bridge — release integrity / integridad de release

## ES

### Estado validado

La cadena de release mantiene la identidad técnica `agent-bridge` y los nombres comerciales **Integración de agentes de IA** (ES) / **AI Integration** (EN).

La primera ejecución de provenance/SBOM validada corresponde al commit `397d7b7536db581caa6701f64f412d0db3d35ac3`. Desde entonces la cadena se ha ampliado sin sustituir aquella evidencia base.

Las superficies verificadas son:

1. archive runtime genérico determinista;
2. bundle Linux/systemd determinista;
3. bundle Windows x64 Service determinista;
4. archive OCI de la imagen Docker;
5. SBOM CycloneDX de dependencias de aplicación;
6. SBOM SPDX de la imagen OCI completa.

### Runtime genérico

El archive genérico contiene `dist/src`, `package.json`, `package-lock.json` y `README.md`. Usa orden estable, timestamp normalizado, ownership numérico normalizado y gzip determinista. Su SHA-256 queda registrado en `SHA256SUMS` y `release-manifest.json`.

En la primera ejecución validada:

- SHA-256 runtime: `7ac7dc4a6bbe3bf15515da1ab9c347c0a0b6680343507b3f0a6041ceeb82f712`;
- SHA-256 SBOM CycloneDX: `a5076367e69ee5cfd7870ea212ced010e44892f675e753037ace9302bb0f550d`.

### Linux/systemd

El bundle Linux consume el mismo `dist/src` ya verificado, incluye dependencias de producción bloqueadas por el lockfile y añade `runtime-release.json`, systemd endurecido, instalador, activación/rollback, configuración de ejemplo y documentación ES/EN.

La instalación usa directorios inmutables `sha256-<runtime-artifact-sha256>`. El bundle Linux tiene SHA-256 y provenance propios, además de un drill instalado que demuestra rollback al release anterior exacto conservando estado durable.

### Windows Service

`Windows Service Packaging` construye un ZIP x64 determinista desde el mismo source SHA y versión. El runtime sigue siendo Node.js 22+ y las dependencias de producción se instalan desde el lockfile. Si aparece un addon nativo `.node`, el packaging falla cerrado hasta disponer de un build de dependencias específico de Windows.

El servicio usa WinSW 2.12.0 x64 como wrapper. El binario está fijado por SHA-256:

`05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da`

La evidencia `windows-service-evidence.json` enlaza versión, commit fuente, plataforma `windows/x64/service`, ZIP, SHA-256 y wrapper exacto. En `main`, el ZIP recibe provenance OIDC/Sigstore. El workflow también ejecuta en `windows-latest` un drill instalado que demuestra candidato fallido -> rollback automático -> release anterior exacto con configuración y estado durable preservados.

### OCI / Docker

La imagen de release no recompila TypeScript. `packaging/docker/Dockerfile.release` consume `dist/src` previamente verificado e instala dependencias de producción desde el lockfile.

Release Integrity registra por separado SHA-256 del archive OCI, digest del manifest ejecutable `linux/amd64`, manifest de attestation BuildKit, blob SPDX, SHA-256 de `oci-sbom.spdx.json` y número de packages. Runtime genérico y OCI mantienen identidades/digests distintos.

### Atestaciones y checksums

En `main`, la evidencia de supply chain cubre:

- provenance del runtime archive;
- provenance del bundle Linux/systemd;
- provenance del bundle Windows x64 Service;
- provenance del archive OCI;
- CycloneDX ligado al runtime archive;
- SPDX ligado al archive OCI.

La firma usa identidad OIDC de GitHub Actions y certificados Sigstore de corta duración; no existe una clave privada de firma de larga duración almacenada en el repositorio.

`SHA256SUMS` verifica las superficies producidas por Release Integrity. Windows mantiene además su evidencia SHA-256 independiente en `windows-service-evidence.json`. La promoción stable vuelve a comprobar todos esos bytes antes de publicar.

### Promoción estable cross-platform

`Stable Release Promotion` cambia de candidate/dev a `stable` **sin reconstruir ningún artefacto de distribución**.

Solo continúa cuando:

- el tag es anotado y GitHub verifica su firma;
- el tag apunta directamente a un commit que ya pertenece a `main`;
- `package.json` contiene una versión estable exacta `MAJOR.MINOR.PATCH` y el tag coincide con `vMAJOR.MINOR.PATCH`;
- existe un `Release Integrity` exitoso en `main` para el SHA exacto;
- existe un `Windows Service Packaging` exitoso en `main` para el mismo SHA exacto;
- ambos artifacts fuente existen una sola vez y no están expirados;
- `release-manifest.json` coincide con versión/commit y `SHA256SUMS` revalida runtime/Linux/OCI/SBOMs;
- `windows-service-evidence.json` coincide con versión/commit/plataforma y revalida el ZIP Windows;
- la evidencia Windows exige WinSW 2.12.0 y el SHA-256 fijado;
- runtime, Linux y OCI verifican provenance contra `release-integrity.yml` + SHA + `refs/heads/main`;
- Windows verifica provenance contra `windows-service.yml` + el mismo SHA + `refs/heads/main`.

La promoción descarga los bytes ya construidos por ambos workflows. No ejecuta `docker build`, `npm run build`, `build-linux-service-bundle` ni `build-windows-service-bundle`.

`stable-promotion.json` registra el tag, versión, SHA fuente, runs/artifacts de Release Integrity y Windows Service Packaging, SHA-256 de `release-manifest.json` y SHA-256 de `windows-service-evidence.json`. Ese registro recibe una nueva attestation OIDC/Sigstore que evidencia el acto de promoción.

La GitHub Release inmutable publica conjuntamente runtime, Linux, Windows, OCI, checksums, SBOMs, manifests y `stable-promotion.json`. Si la release ya existe, el workflow falla en lugar de mutarla.

### Primera stable

La política cross-platform está preparada, pero **todavía no existe una primera promoción estable ejecutada** porque `package.json` continúa en `0.1.0-dev.0`.

Cuando se apruebe la primera versión estable:

1. cambiar `package.json` a una versión estable exacta, por ejemplo `0.1.0`;
2. mergear el cambio a `main` y exigir verdes Release Integrity + Windows Service Packaging + CI + CodeQL;
3. crear un tag anotado y firmado `v0.1.0` sobre ese SHA exacto;
4. dejar que `Stable Release Promotion` publique los mismos bytes ya verificados.

### Rollback

Docker, Linux y Windows conservan estado/configuración fuera de los bytes inmutables de release y tienen mecanismos de rollback al release anterior exacto. Linux y Windows cuentan con drills instalados automatizados. La política común sigue bloqueando colisiones versión/digest y downgrades no confiables.

### Frontera abierta

Después de unificar la promoción GitHub cross-platform siguen separados:

- primera ejecución/evidencia real de una stable;
- promoción OCI a registry sin rebuild ni cambio de digest;
- A2A clustered/shared storage;
- observabilidad y superficies de operador en Kairoseth Platform.

La futura promoción a registry debe reutilizar exactamente la identidad/digest OCI ya verificada.

---

## EN

### Validated state

The release chain preserves technical identity `agent-bridge` and commercial names **Integración de agentes de IA** (ES) / **AI Integration** (EN).

The first validated provenance/SBOM run corresponds to commit `397d7b7536db581caa6701f64f412d0db3d35ac3`. The chain has expanded without replacing that baseline evidence.

Verified distribution surfaces are:

1. deterministic generic runtime archive;
2. deterministic Linux/systemd bundle;
3. deterministic Windows x64 Service bundle;
4. OCI Docker image archive;
5. CycloneDX application dependency SBOM;
6. full OCI image SPDX SBOM.

### Generic runtime

The generic archive contains `dist/src`, `package.json`, `package-lock.json`, and `README.md`, with stable ordering, normalized timestamps/ownership, and deterministic gzip metadata. Its SHA-256 is recorded in `SHA256SUMS` and `release-manifest.json`.

The first validated run recorded runtime SHA-256 `7ac7dc4a6bbe3bf15515da1ab9c347c0a0b6680343507b3f0a6041ceeb82f712` and CycloneDX SHA-256 `a5076367e69ee5cfd7870ea212ced010e44892f675e753037ace9302bb0f550d`.

### Linux/systemd

The Linux bundle consumes the same verified `dist/src`, lockfile-bound production dependencies, `runtime-release.json`, hardened systemd unit, installer/activation/rollback adapters, sample configuration, and ES/EN documentation.

Installed bytes live under immutable `sha256-<runtime-artifact-sha256>` directories. Linux carries its own SHA-256/provenance and an installed rollback drill that restores the exact previous release while preserving durable state.

### Windows Service

`Windows Service Packaging` creates a deterministic x64 ZIP for the same source SHA/version. The runtime requires Node.js 22+ and production dependencies come from the committed lockfile. Native `.node` addons fail packaging closed until a Windows-specific dependency build is intentionally introduced.

The service wrapper is WinSW 2.12.0 x64 pinned to SHA-256 `05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da`.

`windows-service-evidence.json` binds version, source commit, `windows/x64/service`, ZIP filename/SHA-256 and wrapper identity. On `main`, the ZIP receives OIDC/Sigstore provenance. A `windows-latest` installed drill proves failed candidate -> automatic rollback -> exact previous release with operator configuration and durable state preserved.

### OCI / Docker

The release image does not rebuild TypeScript. `packaging/docker/Dockerfile.release` consumes verified `dist/src` and installs production dependencies from the lockfile. OCI archive SHA-256, runnable `linux/amd64` manifest digest, BuildKit attestation manifest, SPDX blob/hash and package count are tracked independently from the generic runtime identity.

### Attestations and checksums

Main-branch supply-chain evidence covers runtime, Linux, Windows and OCI provenance plus CycloneDX/SPDX SBOM attestations. Signing uses GitHub Actions OIDC identity and short-lived Sigstore certificates; no long-lived signing private key is stored in the repository.

`SHA256SUMS` covers Release Integrity surfaces. Windows also carries independent `windows-service-evidence.json` SHA evidence. Stable promotion re-verifies both sets of bytes.

### Cross-platform signed stable promotion

`Stable Release Promotion` promotes to `stable` **without rebuilding distribution bytes**.

It requires:

- a GitHub-verified signed annotated tag pointing directly to a commit already on `main`;
- exact stable `MAJOR.MINOR.PATCH` in `package.json` matching `vMAJOR.MINOR.PATCH`;
- successful exact-SHA `Release Integrity` and `Windows Service Packaging` push runs on `main`;
- exactly one non-expired expected artifact from each source workflow;
- release manifest/version/source/checksum validation for runtime/Linux/OCI/SBOMs;
- Windows evidence/version/source/platform/checksum validation and the exact pinned WinSW identity;
- exact provenance verification for runtime/Linux/OCI against `release-integrity.yml`;
- exact provenance verification for Windows against `windows-service.yml`;
- the same source SHA and `refs/heads/main` across every provenance check.

Promotion only downloads existing artifacts. It does not execute distribution build commands.

`stable-promotion.json` records the tag/version/source SHA, both source workflow runs/artifacts, release-manifest SHA-256, Windows-evidence SHA-256, and promotion run identity. The promotion record receives its own OIDC/Sigstore attestation.

One immutable GitHub Release then publishes runtime, Linux, Windows, OCI, checksums, SBOMs and evidence together. Existing releases are never silently replaced or mutated.

### First stable status

The cross-platform policy is ready, but **no first stable promotion has been executed yet** because the package remains `0.1.0-dev.0`.

When the first stable version is approved:

1. change `package.json` to an exact stable version such as `0.1.0`;
2. merge to `main` and require green Release Integrity + Windows Service Packaging + CI + CodeQL;
3. create a signed annotated `v0.1.0` tag on that exact SHA;
4. let Stable Release Promotion publish the already-verified bytes.

### Rollback

Docker, Linux and Windows keep durable configuration/state outside immutable release bytes and support exact previous-release rollback. Linux and Windows have automated installed rollback drills. Shared policy continues to reject version/digest collisions and untrusted downgrades.

### Remaining boundary

After cross-platform GitHub promotion is unified, the remaining work is:

- first real stable promotion/evidence run;
- OCI registry promotion without rebuild/digest change;
- clustered/shared A2A storage;
- Kairoseth Platform observability/operator surfaces.

Future registry promotion must reuse the already-verified OCI identity/digest exactly.

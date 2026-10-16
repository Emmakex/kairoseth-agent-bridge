# Agent Bridge — release integrity / integridad de release

## ES

### Estado validado

`Release Integrity` construye artefactos reproducibles y verificables para la identidad técnica estable `agent-bridge`. La cadena no cambia el nombre comercial: **Integración de agentes de IA** en ES y **AI Integration** en EN.

La primera ejecución de provenance/SBOM validada corresponde al commit `397d7b7536db581caa6701f64f412d0db3d35ac3`. Desde entonces la cadena se ha ampliado sin reemplazar aquella evidencia base.

Actualmente `Release Integrity` valida `npm ci` + typecheck + tests + build y genera desde el runtime ya compilado:

1. archive runtime genérico determinista;
2. bundle Linux/systemd determinista;
3. archive OCI de la imagen Docker;
4. SBOM CycloneDX de dependencias de aplicación;
5. SBOM SPDX de la imagen OCI completa.

### Runtime archive

El archive genérico contiene `dist/src`, `package.json`, `package-lock.json` y `README.md`. Se empaqueta con orden estable, timestamp normalizado, propietario/grupo numéricos normalizados y gzip sin timestamp variable. Su SHA-256 se registra en `SHA256SUMS` y `release-manifest.json`.

En la primera ejecución validada:

- SHA-256 runtime: `7ac7dc4a6bbe3bf15515da1ab9c347c0a0b6680343507b3f0a6041ceeb82f712`;
- SHA-256 SBOM CycloneDX: `a5076367e69ee5cfd7870ea212ced010e44892f675e753037ace9302bb0f550d`.

### OCI / Docker

La imagen de release no recompila TypeScript. `packaging/docker/Dockerfile.release` consume el `dist/src` previamente verificado e instala dependencias de producción desde el lockfile.

Release Integrity registra separadamente el SHA-256 del archive OCI, el digest del manifest ejecutable `linux/amd64`, el manifest de attestation BuildKit, el blob SPDX, el SHA-256 de `oci-sbom.spdx.json` y el número de packages del SBOM. La imagen y el runtime genérico son superficies distintas y conservan identidad/digest propios.

### Linux/systemd

El bundle Linux se genera desde el mismo `dist/src` verificado y contiene runtime precompilado, dependencias de producción bloqueadas por el lockfile, `runtime-release.json`, unidad systemd endurecida, instalador/activación/rollback, configuración de ejemplo y documentación ES/EN.

`runtime-release.json` enlaza el bundle con el SHA-256 del runtime genérico. La instalación usa un directorio inmutable `sha256-<runtime-artifact-sha256>`. El bundle Linux tiene su propio SHA-256 y provenance attestation.

### Atestaciones y checksums

En `main`, `actions/attest@v4` produce evidencia independiente para:

- SLSA provenance del runtime archive;
- SLSA provenance del bundle Linux/systemd;
- SLSA provenance del archive OCI;
- SBOM CycloneDX ligado al runtime archive;
- SBOM SPDX ligado al archive OCI.

La firma utiliza identidad OIDC del workflow y certificados Sigstore de corta duración; no se almacena una clave privada de firma de larga duración.

`SHA256SUMS` cubre los archivos descargables y `release-manifest.json` registra versión, commit fuente, runtime, Linux, OCI, SBOMs y metadatos de build. El workflow ejecuta `sha256sum --check` antes de emitir attestations o publicar el bundle.

### Promoción estable firmada

`Stable Release Promotion` formaliza la promoción a `stable` **sin recompilar los artefactos de distribución**.

Una promoción estable solo puede continuar si:

- el tag es anotado; los lightweight tags se rechazan;
- GitHub marca la firma del objeto tag como verificada;
- el tag apunta directamente a un commit;
- el commit etiquetado ya pertenece a `main`;
- `package.json` contiene una versión estable exacta `MAJOR.MINOR.PATCH`, sin prerelease ni build metadata;
- el tag coincide exactamente con `vMAJOR.MINOR.PATCH`;
- existe un `Release Integrity` exitoso en `main` para ese SHA exacto;
- existe exactamente un artifact no expirado con el nombre esperado para versión + SHA;
- `release-manifest.json` coincide con versión y source commit;
- `SHA256SUMS` vuelve a verificar todos los bytes descargados;
- las attestations del runtime, Linux y OCI se verifican contra el repositorio antes de promover.

El workflow descarga el artifact ya construido por `Release Integrity`; no vuelve a construir el runtime, el bundle Linux ni el OCI para cambiar de canal.

Después genera `stable-promotion.json` con el tag, versión, SHA fuente, run de Release Integrity, artifact fuente y SHA-256 de `release-manifest.json`. Ese manifiesto recibe una nueva attestation OIDC/Sigstore que demuestra el acto de promoción.

Finalmente se crea una GitHub Release inmutable con los mismos runtime/Linux/OCI/SBOMs/checksums ya verificados. Si la GitHub Release ya existe, el workflow falla en lugar de reemplazarla o modificarla silenciosamente.

### Estado de la primera stable

La política está implementada, pero **todavía no existe una primera promoción estable ejecutada** porque el paquete continúa en `0.1.0-dev.0`. No se debe crear un tag estable mientras `package.json` siga en versión candidate/dev.

Cuando se decida la primera versión estable, el orden correcto es:

1. llevar `package.json` a una versión estable exacta, por ejemplo `0.1.0`;
2. mergear ese cambio a `main` y exigir Release Integrity verde;
3. crear un tag anotado y firmado `v0.1.0` sobre ese SHA exacto;
4. dejar que `Stable Release Promotion` reutilice y publique los bytes ya verificados.

### Rollback

La instalación/update rechaza colisiones versión/digest, bloquea downgrades arbitrarios, requiere opt-in para candidates y permite rollback únicamente al descriptor exacto de la release previa confiable. Docker liga la activación a la imagen exacta y Linux al directorio digest-bound exacto; ambos tienen drills instalados de rollback con estado durable fuera de los bytes de release.

### Frontera que sigue abierta

La política de GitHub Release stable queda separada de:

- primera ejecución/evidencia real de una stable;
- promoción OCI a registry sin rebuild y conservando digest;
- Windows Service packaging;
- A2A clustered/shared storage;
- observabilidad y superficies de operador en Kairoseth Platform.

La promoción a registry, cuando se implemente, debe reutilizar la misma identidad OCI/digest ya verificada; nunca reconstruir otra imagen bajo la misma versión estable.

---

## EN

### Validated state

`Release Integrity` builds reproducible, verifiable artifacts for the stable technical identity `agent-bridge`. Distribution does not change the commercial names: **Integración de agentes de IA** in ES and **AI Integration** in EN.

The first validated provenance/SBOM run corresponds to commit `397d7b7536db581caa6701f64f412d0db3d35ac3`. The supply-chain workflow has since expanded without replacing that baseline evidence.

`Release Integrity` now validates `npm ci` + typecheck + tests + build and creates from the already-built runtime:

1. deterministic generic runtime archive;
2. deterministic Linux/systemd bundle;
3. OCI Docker image archive;
4. CycloneDX application dependency SBOM;
5. full OCI image SPDX SBOM.

### Runtime archive

The generic archive contains `dist/src`, `package.json`, `package-lock.json`, and `README.md`. Packaging uses stable ordering, normalized timestamps/numeric ownership, and deterministic gzip metadata. Its SHA-256 is recorded in `SHA256SUMS` and `release-manifest.json`.

For the first validated run:

- runtime SHA-256: `7ac7dc4a6bbe3bf15515da1ab9c347c0a0b6680343507b3f0a6041ceeb82f712`;
- CycloneDX SBOM SHA-256: `a5076367e69ee5cfd7870ea212ced010e44892f675e753037ace9302bb0f550d`.

### OCI / Docker

The release image does not rebuild TypeScript. `packaging/docker/Dockerfile.release` consumes verified prebuilt `dist/src` and installs production dependencies from the committed lockfile.

Release Integrity separately records the OCI archive SHA-256, runnable `linux/amd64` manifest digest, BuildKit attestation manifest, SPDX blob, standalone `oci-sbom.spdx.json` SHA-256, and package count. The OCI and generic runtime surfaces remain distinct artifacts with their own identities/digests.

### Linux/systemd

The Linux bundle consumes the same verified `dist/src` and includes the prebuilt runtime, lockfile-bound production dependency tree, `runtime-release.json`, hardened systemd unit, install/activation/rollback adapters, environment example, and ES/EN documentation.

`runtime-release.json` binds the installed release to the generic runtime SHA-256. Installed bytes live under immutable `sha256-<runtime-artifact-sha256>` directories. The outer Linux bundle has its own SHA-256 and provenance attestation.

### Attestations and checksums

On `main`, `actions/attest@v4` emits independent evidence for runtime, Linux and OCI provenance plus CycloneDX and SPDX SBOM attestations. Signing uses workflow OIDC identity and short-lived Sigstore certificates; the repository does not store a long-lived signing private key.

`SHA256SUMS` covers downloadable artifacts and `release-manifest.json` records source version/commit, runtime, Linux, OCI, SBOM and build evidence. The workflow executes `sha256sum --check` before attestations or publication.

### Signed stable promotion

`Stable Release Promotion` formalizes promotion to `stable` **without rebuilding distribution artifacts**.

Promotion is allowed only when:

- the tag is annotated; lightweight tags are rejected;
- GitHub reports the tag-object signature as verified;
- the tag points directly to a commit;
- the tagged commit already belongs to `main`;
- `package.json` contains exact stable `MAJOR.MINOR.PATCH` with no prerelease/build metadata;
- the tag exactly matches `vMAJOR.MINOR.PATCH`;
- a successful `Release Integrity` push run exists on `main` for that exact SHA;
- exactly one non-expired version+SHA release artifact exists;
- `release-manifest.json` matches the stable version and source commit;
- `SHA256SUMS` re-verifies the downloaded bytes;
- runtime, Linux and OCI attestations verify against the repository before promotion.

The workflow downloads the artifact already built by `Release Integrity`; it does not rebuild runtime, Linux, or OCI bytes just to change channel.

It then creates `stable-promotion.json` containing tag, version, source SHA, source Release Integrity run/artifact, and the SHA-256 of `release-manifest.json`. That promotion record receives its own OIDC/Sigstore attestation.

Finally, an immutable GitHub Release publishes the same verified runtime/Linux/OCI/SBOM/checksum surfaces. If the release already exists, promotion fails rather than silently replacing or mutating it.

### First stable status

The policy is implemented, but **no first stable promotion has been executed yet** because the package is still `0.1.0-dev.0`. A stable tag must not be created while `package.json` remains on a dev/candidate version.

When the first stable version is approved, the correct sequence is:

1. change `package.json` to an exact stable version, for example `0.1.0`;
2. merge that change to `main` and require green Release Integrity;
3. create a signed annotated `v0.1.0` tag on that exact SHA;
4. let `Stable Release Promotion` reuse and publish the already-verified bytes.

### Rollback

The common update policy rejects version/digest collisions, blocks arbitrary downgrade, requires candidate opt-in, and permits rollback only to the exact trusted previous release descriptor. Docker binds activation to the exact image; Linux binds it to the exact digest-named release directory. Both have installed rollback drills with durable state outside release bytes.

### Remaining boundary

The stable GitHub Release policy remains separate from:

- the first real stable promotion/evidence run;
- OCI registry promotion without rebuild while preserving digest;
- Windows Service packaging;
- clustered/shared A2A storage;
- Kairoseth Platform observability/operator surfaces.

Future registry promotion must reuse the already-verified OCI identity/digest and must never rebuild different bytes under the same stable version.

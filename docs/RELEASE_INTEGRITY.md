# Agent Bridge — release integrity / integridad de release

## ES

### Estado validado

El workflow `Release Integrity` construye en `main` un artefacto de runtime reproducible y verificable sin cambiar la identidad técnica `agent-bridge`.

La primera ejecución validada corresponde al commit `397d7b7536db581caa6701f64f412d0db3d35ac3` y produjo el artefacto `agent-bridge-0.1.0-dev.0-397d7b7536db.tar.gz`.

El bundle contiene el runtime compilado desde `dist/src`, `package.json`, `package-lock.json`, `README.md`, un SBOM CycloneDX, `SHA256SUMS`, `release-manifest.json` y los bundles locales de atestación.

### Reproducibilidad e integridad

El runtime se construye después de `npm ci` y de la suite completa de typecheck, tests y build. El archivo se empaqueta con orden estable, timestamps normalizados, propietario/grupo numéricos normalizados y cabecera gzip sin timestamp variable.

`SHA256SUMS` vincula el runtime y el SBOM. `release-manifest.json` registra versión de package, commit fuente, nombres y hashes, versión de Node, workflow, run ID y attempt.

En la primera ejecución validada:

- SHA-256 runtime: `7ac7dc4a6bbe3bf15515da1ab9c347c0a0b6680343507b3f0a6041ceeb82f712`;
- SHA-256 SBOM: `a5076367e69ee5cfd7870ea212ced010e44892f675e753037ace9302bb0f550d`.

Los hashes fueron verificados nuevamente después de descargar el artifact publicado por GitHub Actions.

### Atestaciones

El mismo digest del runtime recibe dos atestaciones mediante `actions/attest@v4`:

1. SLSA build provenance con predicate `https://slsa.dev/provenance/v1`;
2. CycloneDX SBOM attestation con predicate `https://cyclonedx.org/bom`.

Las dos atestaciones de la primera ejecución validada contienen exactamente el SHA-256 del runtime indicado arriba. La firma usa certificados Sigstore de corta duración emitidos a partir de la identidad OIDC del workflow; no se introduce una clave privada de firma de larga duración en el repositorio.

### Frontera

Esta baseline cubre integridad, procedencia y relación artefacto/SBOM. Aún permanecen separados el tagging/versionado estable, la publicación formal de GitHub Release, los paquetes Docker/Linux/Windows y la estrategia de update/rollback. La promoción futura debe reutilizar el mismo artifact verificado, no reconstruir bytes distintos bajo la misma versión.

## EN

### Validated state

The `Release Integrity` workflow builds a reproducible and verifiable runtime artifact on `main` without changing the stable `agent-bridge` technical identity.

The first validated run corresponds to commit `397d7b7536db581caa6701f64f412d0db3d35ac3` and produced `agent-bridge-0.1.0-dev.0-397d7b7536db.tar.gz`.

The bundle contains the compiled runtime from `dist/src`, `package.json`, `package-lock.json`, `README.md`, a CycloneDX SBOM, `SHA256SUMS`, `release-manifest.json`, and the local attestation bundles.

### Reproducibility and integrity

The runtime is built after `npm ci` and the complete typecheck/test/build suite. Packaging uses stable file ordering, normalized timestamps, normalized numeric owner/group metadata, and a gzip header without a variable timestamp.

`SHA256SUMS` binds the runtime and SBOM. `release-manifest.json` records package version, source commit, filenames and digests, Node version, workflow, run ID, and attempt.

For the first validated run:

- runtime SHA-256: `7ac7dc4a6bbe3bf15515da1ab9c347c0a0b6680343507b3f0a6041ceeb82f712`;
- SBOM SHA-256: `a5076367e69ee5cfd7870ea212ced010e44892f675e753037ace9302bb0f550d`.

The hashes were independently checked again after downloading the artifact published by GitHub Actions.

### Attestations

The same runtime digest receives two attestations through `actions/attest@v4`:

1. SLSA build provenance with predicate `https://slsa.dev/provenance/v1`;
2. CycloneDX SBOM attestation with predicate `https://cyclonedx.org/bom`.

Both attestations from the first validated run contain exactly the runtime SHA-256 listed above. Signing uses short-lived Sigstore certificates minted from the workflow OIDC identity, so this flow introduces no long-lived private signing key into the repository.

### Boundary

This baseline covers integrity, provenance, and artifact/SBOM binding. Stable tagging/version management, formal GitHub Release publication, Docker/Linux/Windows packaging, and installed-runtime update/rollback remain separate controls. Future promotion must reuse the verified artifact rather than rebuilding different bytes under the same version.

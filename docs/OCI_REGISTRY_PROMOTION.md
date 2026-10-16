# OCI registry promotion / promoción OCI a registry

## ES

La imagen estable de Agent Bridge se publica en GitHub Container Registry (GHCR) **sin reconstruirla**.

La fuente única es el archive OCI producido y atestado por `Release Integrity` para el mismo commit que recibe el tag estable. `Stable Release Promotion` descarga ese archive ya verificado y lee `ociImage.exportDigest` desde `release-manifest.json`.

Destino estable:

`ghcr.io/emmakex/kairoseth-agent-bridge:<versión>`

No se publica ni se mueve `latest` durante esta fase. El tag versionado es la referencia humana; el digest sigue siendo la identidad inmutable.

### Reglas fail-closed

Antes de publicar se exige:

- tag estable anotado, firmado y verificado;
- commit perteneciente a `main`;
- versión SemVer estable exacta;
- `Release Integrity` verde para ese SHA;
- archive OCI y `release-manifest.json` con checksums válidos;
- provenance OIDC/Sigstore del archive OCI ligado a `release-integrity.yml`, SHA fuente y `refs/heads/main`;
- `ociImage.exportDigest` con formato `sha256:<64 hex>`.

La transferencia usa `skopeo copy --all --preserve-digests`. Si el registry no puede conservar los digests, la operación falla.

### Idempotencia e inmutabilidad

Si `ghcr.io/emmakex/kairoseth-agent-bridge:<versión>` no existe, se copia el archive OCI verificado.

Si ya existe:

- mismo digest verificado -> no-op seguro;
- digest diferente -> fallo inmediato; nunca se sobrescribe silenciosamente una versión estable.

Después de la copia, el workflow vuelve a consultar GHCR y exige que el digest publicado coincida exactamente con `ociImage.exportDigest`.

`stable-promotion.json` registra imagen, referencia versionada y digest de registry junto a la evidencia de runtime/Linux/Windows/OCI.

### Autenticación

El workflow usa el `GITHUB_TOKEN` del propio repositorio con permiso mínimo `packages: write`; no requiere un PAT de larga duración para publicar el package asociado al repositorio.

### Relación con la GitHub Release

La publicación al registry ocurre antes de crear la GitHub Release final. Esto es reintentable porque una referencia ya existente con el mismo digest se acepta como no-op, mientras que una referencia con otro digest bloquea la promoción.

La GitHub Release conserva además el archive OCI original, `oci-image.json`, SBOM SPDX, checksums y `stable-promotion.json`.

## EN

The stable Agent Bridge image is published to GitHub Container Registry (GHCR) **without rebuilding it**.

The sole source is the OCI archive produced and attested by `Release Integrity` for the same commit receiving the stable tag. `Stable Release Promotion` downloads those already-verified bytes and reads `ociImage.exportDigest` from `release-manifest.json`.

Stable destination:

`ghcr.io/emmakex/kairoseth-agent-bridge:<version>`

No `latest` tag is published or moved in this phase. The version tag is the human reference; the digest remains the immutable identity.

### Fail-closed rules

Promotion requires:

- a verified signed annotated stable tag;
- source commit already on `main`;
- exact stable SemVer;
- successful exact-SHA `Release Integrity` run;
- verified OCI archive/checksums/manifest;
- exact OIDC/Sigstore provenance bound to `release-integrity.yml`, source SHA and `refs/heads/main`;
- a valid `sha256:<64 hex>` `ociImage.exportDigest`.

Transfer uses `skopeo copy --all --preserve-digests`. If the destination cannot preserve digests, the copy fails.

### Idempotency and immutability

If `ghcr.io/emmakex/kairoseth-agent-bridge:<version>` does not exist, the verified OCI archive is copied.

If it already exists:

- same verified digest -> safe no-op;
- different digest -> immediate failure; a stable version is never silently overwritten.

After copy, the workflow re-inspects GHCR and requires the published digest to exactly equal `ociImage.exportDigest`.

`stable-promotion.json` records registry image, versioned reference and digest alongside runtime/Linux/Windows/OCI evidence.

### Authentication

The workflow uses the repository `GITHUB_TOKEN` with the minimum `packages: write` permission; no long-lived PAT is required for publishing the repository-associated package.

### GitHub Release relationship

Registry publication happens before final GitHub Release creation. The registry operation is retry-safe because an existing reference with the same digest is accepted as a no-op while any different digest blocks promotion.

The GitHub Release also retains the original OCI archive, `oci-image.json`, SPDX SBOM, checksums and `stable-promotion.json`.

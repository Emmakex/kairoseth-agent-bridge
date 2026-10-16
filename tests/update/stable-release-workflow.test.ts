import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const WORKFLOW_PATH = new URL(
  "../../.github/workflows/stable-release.yml",
  import.meta.url,
);

async function workflow(): Promise<string> {
  return readFile(WORKFLOW_PATH, "utf8");
}

test("stable promotion requires a GitHub-verified annotated tag on main", async () => {
  const content = await workflow();

  assert.match(content, /REF_TYPE=.*object\.type/);
  assert.match(content, /REF_TYPE.*!=.*tag/);
  assert.match(content, /verification\.verified/);
  assert.match(content, /merge-base --is-ancestor.*origin\/main/);
});

test("stable promotion reuses successful Release Integrity and Windows artifacts without rebuilding distribution bytes", async () => {
  const content = await workflow();

  assert.match(content, /release-integrity\.yml\/runs/);
  assert.match(content, /windows-service\.yml\/runs/);
  assert.match(content, /head_sha=\$\{STABLE_SOURCE_SHA\}/);
  assert.match(content, /status=success/);
  assert.match(content, /SOURCE_WINDOWS_ARTIFACT/);
  assert.match(content, /windows-service-evidence\.json/);
  assert.match(content, /gh run download/);
  assert.match(content, /sha256sum --check SHA256SUMS/);
  assert.doesNotMatch(content, /docker build/);
  assert.doesNotMatch(content, /npm run build/);
  assert.doesNotMatch(content, /build-linux-service-bundle/);
  assert.doesNotMatch(content, /build-windows-service-bundle/);
});

test("stable promotion verifies exact provenance for Release Integrity and Windows surfaces", async () => {
  const content = await workflow();

  assert.match(content, /gh attestation verify/);
  assert.match(content, /--signer-workflow/);
  assert.match(content, /release-integrity\.yml/);
  assert.match(content, /windows-service\.yml/);
  assert.match(content, /--source-digest.*STABLE_SOURCE_SHA/);
  assert.match(content, /--source-ref refs\/heads\/main/);
  assert.match(content, /WinSW/);
  assert.match(content, /05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da/);
});

test("stable promotion copies the verified OCI archive to GHCR without changing its digest", async () => {
  const content = await workflow();

  assert.match(content, /packages: write/);
  assert.match(content, /ghcr\.io\/\$\{GITHUB_REPOSITORY,,\}/);
  assert.match(content, /ociImage\.exportDigest/);
  assert.match(content, /skopeo copy/);
  assert.match(content, /--all/);
  assert.match(content, /--preserve-digests/);
  assert.match(content, /oci-archive:/);
  assert.match(content, /STABLE_REGISTRY_DIGEST/);
  assert.match(content, /Registry tag already points to the exact verified digest/);
  assert.match(content, /already exists with digest/);
  assert.doesNotMatch(content, /:latest/);
});

test("stable promotion emits one attested promotion record and immutable cross-platform release", async () => {
  const content = await workflow();

  assert.match(content, /schemaVersion: "kab\.stable-promotion\.v1"/);
  assert.match(content, /sourceArtifact: process\.env\.SOURCE_RELEASE_ARTIFACT/);
  assert.match(content, /sourceWindowsServiceRunId/);
  assert.match(content, /windowsServiceEvidenceSha256/);
  assert.match(content, /registry: \{/);
  assert.match(content, /STABLE_REGISTRY_REF/);
  assert.match(content, /uses: actions\/attest@v4/);
  assert.match(content, /STABLE_WINDOWS_FILE/);
  assert.match(content, /gh release create/);
  assert.match(content, /--verify-tag/);
});

test("stable promotion refuses to mutate an existing GitHub Release", async () => {
  const content = await workflow();

  assert.match(content, /gh release view/);
  assert.match(content, /GitHub Release .* already exists/);
  assert.match(content, /stable releases are not mutated in place/);
});

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

test("stable promotion reuses a successful Release Integrity artifact", async () => {
  const content = await workflow();

  assert.match(content, /release-integrity\.yml\/runs/);
  assert.match(content, /head_sha=\$\{STABLE_SOURCE_SHA\}/);
  assert.match(content, /status=success/);
  assert.match(content, /gh run download/);
  assert.match(content, /sha256sum --check SHA256SUMS/);
});

test("stable promotion verifies attestations and emits its own promotion attestation", async () => {
  const content = await workflow();

  assert.match(content, /gh attestation verify/);
  assert.match(content, /schemaVersion: "kab\.stable-promotion\.v1"/);
  assert.match(content, /uses: actions\/attest@v4/);
  assert.match(content, /gh release create/);
  assert.match(content, /--verify-tag/);
});

test("stable promotion refuses to mutate an existing GitHub Release", async () => {
  const content = await workflow();

  assert.match(content, /gh release view.*already exists/);
  assert.match(content, /stable releases are not mutated in place/);
});

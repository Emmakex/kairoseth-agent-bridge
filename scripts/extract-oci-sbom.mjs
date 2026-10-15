#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const SHA256_DIGEST = /^sha256:([a-f0-9]{64})$/i;
const ATTESTATION_REFERENCE_TYPE = "attestation-manifest";
const SPDX_PREDICATE_TYPE = "https://spdx.dev/Document";

function fail(message) {
  throw new Error(`OCI SBOM extraction failed: ${message}`);
}

function requireDigest(value, label) {
  if (typeof value !== "string") fail(`${label} is missing.`);
  const match = SHA256_DIGEST.exec(value);
  if (!match) fail(`${label} is not a sha256 digest.`);
  return `sha256:${match[1].toLowerCase()}`;
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
  return value;
}

async function readJson(path, label) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    fail(`${label} could not be read.`);
  }

  try {
    return JSON.parse(raw);
  } catch {
    fail(`${label} is not valid JSON.`);
  }
}

function blobPath(layoutDir, digest) {
  const normalized = requireDigest(digest, "blob digest");
  const hex = normalized.slice("sha256:".length);
  return resolve(layoutDir, "blobs", "sha256", hex);
}

function platformMatches(descriptor, os, architecture) {
  return (
    descriptor &&
    typeof descriptor === "object" &&
    descriptor.platform?.os === os &&
    descriptor.platform?.architecture === architecture &&
    descriptor.annotations?.["vnd.docker.reference.type"] !==
      ATTESTATION_REFERENCE_TYPE
  );
}

function findPlatformManifest(index, os, architecture) {
  if (!Array.isArray(index.manifests)) {
    fail("OCI index does not contain a manifests array.");
  }

  const matches = index.manifests.filter((descriptor) =>
    platformMatches(descriptor, os, architecture),
  );
  if (matches.length !== 1) {
    fail(
      `expected exactly one ${os}/${architecture} image manifest, found ${matches.length}.`,
    );
  }

  return matches[0];
}

function findAttestationManifest(index, subjectDigest) {
  const matches = index.manifests.filter((descriptor) => {
    if (!descriptor || typeof descriptor !== "object") return false;
    const annotations = descriptor.annotations;
    return (
      annotations?.["vnd.docker.reference.type"] ===
        ATTESTATION_REFERENCE_TYPE &&
      annotations?.["vnd.docker.reference.digest"] === subjectDigest
    );
  });

  if (matches.length !== 1) {
    fail(
      `expected exactly one attestation manifest for ${subjectDigest}, found ${matches.length}.`,
    );
  }
  return matches[0];
}

function findSpdxLayer(attestationManifest) {
  if (!Array.isArray(attestationManifest.layers)) {
    fail("attestation manifest does not contain layers.");
  }

  const matches = attestationManifest.layers.filter((layer) => {
    if (!layer || typeof layer !== "object") return false;
    return (
      layer.annotations?.["in-toto.io/predicate-type"] === SPDX_PREDICATE_TYPE
    );
  });

  if (matches.length !== 1) {
    fail(`expected exactly one SPDX SBOM layer, found ${matches.length}.`);
  }
  return matches[0];
}

function validateSpdxStatement(statement, subjectDigest) {
  requireObject(statement, "SBOM in-toto statement");
  if (statement._type !== "https://in-toto.io/Statement/v0.1") {
    fail("SBOM statement has an unsupported in-toto type.");
  }
  if (statement.predicateType !== SPDX_PREDICATE_TYPE) {
    fail("SBOM statement predicateType is not SPDX.");
  }
  if (!Array.isArray(statement.subject) || statement.subject.length === 0) {
    fail("SBOM statement has no subjects.");
  }

  const expectedHex = subjectDigest.slice("sha256:".length);
  const bound = statement.subject.some(
    (subject) =>
      subject &&
      typeof subject === "object" &&
      subject.digest &&
      typeof subject.digest === "object" &&
      typeof subject.digest.sha256 === "string" &&
      subject.digest.sha256.toLowerCase() === expectedHex,
  );
  if (!bound) {
    fail("SPDX statement is not bound to the expected platform manifest digest.");
  }

  const predicate = requireObject(statement.predicate, "SPDX predicate");
  if (
    typeof predicate.spdxVersion !== "string" ||
    !predicate.spdxVersion.startsWith("SPDX-")
  ) {
    fail("SPDX predicate has an invalid spdxVersion.");
  }
  if (!Array.isArray(predicate.packages) || predicate.packages.length === 0) {
    fail("SPDX predicate contains no packages.");
  }

  return predicate;
}

export async function extractOciSbom({
  layoutDir,
  outputPath,
  os = "linux",
  architecture = "amd64",
}) {
  const absoluteLayout = resolve(layoutDir);
  const index = requireObject(
    await readJson(resolve(absoluteLayout, "index.json"), "OCI index"),
    "OCI index",
  );

  const platformDescriptor = findPlatformManifest(index, os, architecture);
  const platformManifestDigest = requireDigest(
    platformDescriptor.digest,
    "platform manifest digest",
  );

  const attestationDescriptor = findAttestationManifest(
    index,
    platformManifestDigest,
  );
  const attestationManifestDigest = requireDigest(
    attestationDescriptor.digest,
    "attestation manifest digest",
  );
  const attestationManifest = requireObject(
    await readJson(
      blobPath(absoluteLayout, attestationManifestDigest),
      "attestation manifest",
    ),
    "attestation manifest",
  );

  const sbomLayer = findSpdxLayer(attestationManifest);
  const sbomBlobDigest = requireDigest(sbomLayer.digest, "SPDX SBOM blob digest");
  const statement = requireObject(
    await readJson(blobPath(absoluteLayout, sbomBlobDigest), "SPDX SBOM statement"),
    "SPDX SBOM statement",
  );
  const spdx = validateSpdxStatement(statement, platformManifestDigest);

  await writeFile(outputPath, `${JSON.stringify(spdx, null, 2)}\n`, "utf8");

  return {
    platform: `${os}/${architecture}`,
    platformManifestDigest,
    attestationManifestDigest,
    sbomBlobDigest,
    packageCount: spdx.packages.length,
  };
}

async function main() {
  const [, , layoutDir, outputPath, os = "linux", architecture = "amd64"] =
    process.argv;
  if (!layoutDir || !outputPath) {
    fail(
      "usage: extract-oci-sbom.mjs <oci-layout-dir> <output-spdx.json> [os] [architecture]",
    );
  }

  const metadata = await extractOciSbom({
    layoutDir,
    outputPath,
    os,
    architecture,
  });
  process.stdout.write(`${JSON.stringify(metadata)}\n`);
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

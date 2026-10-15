import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

function serialized(value: unknown): string {
  return JSON.stringify(value);
}

function digest(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

async function writeBlob(layout: string, content: string): Promise<string> {
  const value = digest(content);
  const hex = value.slice("sha256:".length);
  const directory = join(layout, "blobs", "sha256");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, hex), content, "utf8");
  return value;
}

test("OCI SBOM extractor resolves runnable platform from image config when index omits platform", async () => {
  const root = await mkdtemp(join(tmpdir(), "kab-oci-sbom-"));
  const layout = join(root, "layout");
  const output = join(root, "oci-sbom.spdx.json");

  try {
    await mkdir(layout, { recursive: true });
    await writeFile(
      join(layout, "oci-layout"),
      serialized({ imageLayoutVersion: "1.0.0" }),
      "utf8",
    );

    const configContent = serialized({
      architecture: "amd64",
      os: "linux",
      rootfs: { type: "layers", diff_ids: [] },
    });
    const configDigest = await writeBlob(layout, configContent);

    const imageManifestContent = serialized({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: {
        mediaType: "application/vnd.oci.image.config.v1+json",
        digest: configDigest,
        size: Buffer.byteLength(configContent),
      },
      layers: [],
    });
    const imageManifestDigest = await writeBlob(layout, imageManifestContent);

    const sbomStatementContent = serialized({
      _type: "https://in-toto.io/Statement/v1",
      subject: [
        {
          name: "_",
          digest: { sha256: imageManifestDigest.slice("sha256:".length) },
        },
      ],
      predicateType: "https://spdx.dev/Document",
      predicate: {
        SPDXID: "SPDXRef-DOCUMENT",
        spdxVersion: "SPDX-2.3",
        name: "agent-bridge-test-image",
        packages: [
          {
            SPDXID: "SPDXRef-Package-node",
            name: "node",
            versionInfo: "22.23.3",
          },
        ],
      },
    });
    const sbomDigest = await writeBlob(layout, sbomStatementContent);

    const attestationManifestContent = serialized({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: {
        mediaType: "application/vnd.oci.image.config.v1+json",
        digest: configDigest,
        size: Buffer.byteLength(configContent),
      },
      layers: [
        {
          mediaType: "application/vnd.in-toto+json",
          digest: sbomDigest,
          size: Buffer.byteLength(sbomStatementContent),
          annotations: {
            "in-toto.io/predicate-type": "https://spdx.dev/Document",
          },
        },
      ],
    });
    const attestationManifestDigest = await writeBlob(
      layout,
      attestationManifestContent,
    );

    await writeFile(
      join(layout, "index.json"),
      serialized({
        schemaVersion: 2,
        mediaType: "application/vnd.oci.image.index.v1+json",
        manifests: [
          {
            mediaType: "application/vnd.oci.image.manifest.v1+json",
            digest: imageManifestDigest,
            size: Buffer.byteLength(imageManifestContent),
            // Deliberately no platform metadata: this matches the Buildx OCI
            // layout variant that triggered the production pre-merge gate.
          },
          {
            mediaType: "application/vnd.oci.image.manifest.v1+json",
            digest: attestationManifestDigest,
            size: Buffer.byteLength(attestationManifestContent),
            annotations: {
              "vnd.docker.reference.digest": imageManifestDigest,
              "vnd.docker.reference.type": "attestation-manifest",
            },
            platform: { architecture: "unknown", os: "unknown" },
          },
        ],
      }),
      "utf8",
    );

    const { stdout } = await execFileAsync(process.execPath, [
      "scripts/extract-oci-sbom.mjs",
      layout,
      output,
      "linux",
      "amd64",
    ]);
    const metadata = JSON.parse(stdout) as {
      platform: string;
      platformManifestDigest: string;
      platformConfigDigest: string;
      attestationManifestDigest: string;
      sbomBlobDigest: string;
      packageCount: number;
    };

    assert.equal(metadata.platform, "linux/amd64");
    assert.equal(metadata.platformManifestDigest, imageManifestDigest);
    assert.equal(metadata.platformConfigDigest, configDigest);
    assert.equal(metadata.attestationManifestDigest, attestationManifestDigest);
    assert.equal(metadata.sbomBlobDigest, sbomDigest);
    assert.equal(metadata.packageCount, 1);

    const spdx = JSON.parse(await readFile(output, "utf8")) as {
      spdxVersion: string;
      packages: unknown[];
    };
    assert.equal(spdx.spdxVersion, "SPDX-2.3");
    assert.equal(spdx.packages.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("OCI SBOM extractor rejects index platform metadata that conflicts with image config", async () => {
  const root = await mkdtemp(join(tmpdir(), "kab-oci-sbom-conflict-"));
  const layout = join(root, "layout");
  const output = join(root, "oci-sbom.spdx.json");

  try {
    await mkdir(layout, { recursive: true });
    const configContent = serialized({
      architecture: "amd64",
      os: "linux",
      rootfs: { type: "layers", diff_ids: [] },
    });
    const configDigest = await writeBlob(layout, configContent);
    const manifestContent = serialized({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: {
        mediaType: "application/vnd.oci.image.config.v1+json",
        digest: configDigest,
        size: Buffer.byteLength(configContent),
      },
      layers: [],
    });
    const manifestDigest = await writeBlob(layout, manifestContent);
    await writeFile(
      join(layout, "index.json"),
      serialized({
        schemaVersion: 2,
        manifests: [
          {
            mediaType: "application/vnd.oci.image.manifest.v1+json",
            digest: manifestDigest,
            size: Buffer.byteLength(manifestContent),
            platform: { architecture: "arm64", os: "linux" },
          },
        ],
      }),
      "utf8",
    );

    await assert.rejects(
      () =>
        execFileAsync(process.execPath, [
          "scripts/extract-oci-sbom.mjs",
          layout,
          output,
          "linux",
          "amd64",
        ]),
      /index platform metadata conflicts with image config/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

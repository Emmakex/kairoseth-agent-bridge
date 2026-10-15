import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

function text(value: unknown): string {
  return JSON.stringify(value);
}

function sha(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

async function blob(layout: string, content: string): Promise<string> {
  const digest = sha(content);
  const directory = join(layout, "blobs", "sha256");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, digest.slice(7)), content, "utf8");
  return digest;
}

test("extractor traverses root index to nested Buildx image index and binds SPDX to runnable manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "kab-oci-nested-"));
  const layout = join(root, "layout");
  const output = join(root, "sbom.json");

  try {
    await mkdir(layout, { recursive: true });
    await writeFile(
      join(layout, "oci-layout"),
      text({ imageLayoutVersion: "1.0.0" }),
      "utf8",
    );

    const configContent = text({
      architecture: "amd64",
      os: "linux",
      rootfs: { type: "layers", diff_ids: [] },
    });
    const configDigest = await blob(layout, configContent);

    const imageManifestContent = text({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: {
        mediaType: "application/vnd.oci.image.config.v1+json",
        digest: configDigest,
        size: Buffer.byteLength(configContent),
      },
      layers: [],
    });
    const imageManifestDigest = await blob(layout, imageManifestContent);

    const statementContent = text({
      _type: "https://in-toto.io/Statement/v1",
      subject: [
        {
          name: "_",
          digest: { sha256: imageManifestDigest.slice(7) },
        },
      ],
      predicateType: "https://spdx.dev/Document",
      predicate: {
        SPDXID: "SPDXRef-DOCUMENT",
        spdxVersion: "SPDX-2.3",
        name: "nested-image",
        packages: [
          { SPDXID: "SPDXRef-node", name: "node", versionInfo: "22.23.3" },
        ],
      },
    });
    const statementDigest = await blob(layout, statementContent);

    const attestationContent = text({
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
          digest: statementDigest,
          size: Buffer.byteLength(statementContent),
          annotations: {
            "in-toto.io/predicate-type": "https://spdx.dev/Document",
          },
        },
      ],
    });
    const attestationDigest = await blob(layout, attestationContent);

    const nestedIndexContent = text({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.index.v1+json",
      manifests: [
        {
          mediaType: "application/vnd.oci.image.manifest.v1+json",
          digest: imageManifestDigest,
          size: Buffer.byteLength(imageManifestContent),
        },
        {
          mediaType: "application/vnd.oci.image.manifest.v1+json",
          digest: attestationDigest,
          size: Buffer.byteLength(attestationContent),
          platform: { os: "unknown", architecture: "unknown" },
          annotations: {
            "vnd.docker.reference.type": "attestation-manifest",
            "vnd.docker.reference.digest": imageManifestDigest,
          },
        },
      ],
    });
    const nestedIndexDigest = await blob(layout, nestedIndexContent);

    await writeFile(
      join(layout, "index.json"),
      text({
        schemaVersion: 2,
        mediaType: "application/vnd.oci.image.index.v1+json",
        manifests: [
          {
            mediaType: "application/vnd.oci.image.index.v1+json",
            digest: nestedIndexDigest,
            size: Buffer.byteLength(nestedIndexContent),
            annotations: {
              "org.opencontainers.image.ref.name": "0.1.0-dev.0",
            },
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
      platformManifestDigest: string;
      attestationManifestDigest: string;
      sbomBlobDigest: string;
      packageCount: number;
    };

    assert.equal(metadata.platformManifestDigest, imageManifestDigest);
    assert.equal(metadata.attestationManifestDigest, attestationDigest);
    assert.equal(metadata.sbomBlobDigest, statementDigest);
    assert.equal(metadata.packageCount, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

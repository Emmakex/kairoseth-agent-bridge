#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const SHA256 = /^sha256:([a-f0-9]{64})$/i;

function digestPath(layout, digest) {
  const match = SHA256.exec(String(digest));
  if (!match) return null;
  return resolve(layout, "blobs", "sha256", match[1].toLowerCase());
}

async function json(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

function descriptorSummary(descriptor) {
  return {
    digest: descriptor?.digest ?? null,
    mediaType: descriptor?.mediaType ?? null,
    platform: descriptor?.platform ?? null,
    annotations: descriptor?.annotations ?? null,
  };
}

async function main() {
  const [, , layoutArg, outputArg] = process.argv;
  if (!layoutArg || !outputArg) {
    throw new Error("usage: summarize-oci-attestations.mjs <layout> <output>");
  }

  const layout = resolve(layoutArg);
  const index = await json(resolve(layout, "index.json"));
  if (!index || !Array.isArray(index.manifests)) {
    throw new Error("OCI index missing or malformed.");
  }

  const manifests = [];
  for (const descriptor of index.manifests) {
    const summary = descriptorSummary(descriptor);
    const manifestPath = digestPath(layout, descriptor?.digest);
    const manifest = manifestPath ? await json(manifestPath) : null;
    summary.manifest = manifest
      ? {
          mediaType: manifest.mediaType ?? null,
          subject: manifest.subject ?? null,
          config: descriptorSummary(manifest.config ?? {}),
          layers: [],
        }
      : null;

    if (manifest && Array.isArray(manifest.layers)) {
      for (const layer of manifest.layers) {
        const layerSummary = descriptorSummary(layer);
        const layerPath = digestPath(layout, layer?.digest);
        const statement =
          layer?.mediaType === "application/vnd.in-toto+json" && layerPath
            ? await json(layerPath)
            : null;
        if (statement) {
          layerSummary.statement = {
            type: statement._type ?? null,
            predicateType: statement.predicateType ?? null,
            subject: Array.isArray(statement.subject)
              ? statement.subject.map((item) => ({
                  name: item?.name ?? null,
                  digest: item?.digest ?? null,
                }))
              : null,
            predicate: statement.predicate
              ? {
                  spdxVersion: statement.predicate.spdxVersion ?? null,
                  packageCount: Array.isArray(statement.predicate.packages)
                    ? statement.predicate.packages.length
                    : null,
                  keys: Object.keys(statement.predicate).sort(),
                }
              : null,
          };
        }
        summary.manifest.layers.push(layerSummary);
      }
    }

    manifests.push(summary);
  }

  await writeFile(
    outputArg,
    `${JSON.stringify({
      schemaVersion: index.schemaVersion ?? null,
      mediaType: index.mediaType ?? null,
      manifests,
    }, null, 2)}\n`,
    "utf8",
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

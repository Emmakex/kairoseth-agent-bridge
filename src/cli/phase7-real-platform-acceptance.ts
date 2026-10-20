#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadPhase7RealPlatformAcceptanceConfig,
  runPhase7RealPlatformAcceptance,
} from "../acceptance/phase7-real-platform.js";

async function main(): Promise<void> {
  const runtimeVersion = await resolvePackagedRuntimeVersion();
  const declaredRuntimeVersion = process.env.KAB_ACCEPTANCE_RUNTIME_VERSION?.trim();
  if (declaredRuntimeVersion && declaredRuntimeVersion !== runtimeVersion) {
    throw new Error(
      `KAB_ACCEPTANCE_RUNTIME_VERSION=${declaredRuntimeVersion} does not match the packaged Agent Bridge version ${runtimeVersion}.`,
    );
  }

  const config = await loadPhase7RealPlatformAcceptanceConfig({
    ...process.env,
    KAB_ACCEPTANCE_RUNTIME_VERSION: runtimeVersion,
  });
  const evidence = await runPhase7RealPlatformAcceptance(config);
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}

async function resolvePackagedRuntimeVersion(): Promise<string> {
  let current = dirname(fileURLToPath(import.meta.url));

  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(current, "package.json");
    try {
      const raw = await readFile(candidate, "utf8");
      const manifest = JSON.parse(raw) as {
        name?: unknown;
        version?: unknown;
      };
      if (
        manifest.name === "kairoseth-agent-bridge" &&
        typeof manifest.version === "string" &&
        manifest.version.trim()
      ) {
        return manifest.version.trim();
      }
    } catch (error) {
      if (!isFileNotFound(error)) throw error;
    }

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  throw new Error("Unable to resolve packaged Agent Bridge version for Phase 7 acceptance.");
}

function isFileNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown Phase 7 acceptance failure.";
  process.stderr.write(
    `${JSON.stringify({
      level: "error",
      event: "phase7_real_platform_acceptance_failed",
      message,
    })}\n`,
  );
  process.exitCode = 1;
});

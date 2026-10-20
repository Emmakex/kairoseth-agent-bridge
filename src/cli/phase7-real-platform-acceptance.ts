#!/usr/bin/env node

import {
  loadPhase7RealPlatformAcceptanceConfig,
  runPhase7RealPlatformAcceptance,
} from "../acceptance/phase7-real-platform.js";

async function main(): Promise<void> {
  const config = await loadPhase7RealPlatformAcceptanceConfig();
  const evidence = await runPhase7RealPlatformAcceptance(config);
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
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

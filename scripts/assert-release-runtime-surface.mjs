import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const requiredRuntimeFiles = [
  new URL("../dist/src/cli/agent-bridge-runtime.js", import.meta.url),
  new URL("../dist/src/cli/phase7-real-platform-acceptance.js", import.meta.url),
];

for (const url of requiredRuntimeFiles) {
  const path = fileURLToPath(url);
  try {
    const metadata = await stat(path);
    if (!metadata.isFile()) throw new Error("not a regular file");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Release runtime surface is incomplete: ${path} (${reason}).`);
  }
}

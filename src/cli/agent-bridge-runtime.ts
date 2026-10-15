#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { RuntimeReadiness } from "../control-channel/session.js";
import {
  loadRuntimeProcessConfig,
  type RuntimeProcessConfig,
} from "../runtime/process-config.js";
import { FileRuntimeProcessStatusStore } from "../runtime/process-status.js";
import { ProductionRuntime } from "../runtime/production-runtime.js";

const STATUS_HEARTBEAT_MS = 15_000;

async function main(): Promise<void> {
  const command = process.argv[2] ?? "run";

  if (command === "healthcheck") {
    const stateDir = resolve(
      process.env.KAB_STATE_DIR?.trim() || "/var/lib/agent-bridge",
    );
    const store = new FileRuntimeProcessStatusStore(
      join(stateDir, "runtime", "status.json"),
    );
    process.exitCode = (await store.healthy()) ? 0 : 1;
    return;
  }

  if (command !== "run" && command !== "enroll") {
    throw new Error("Usage: agent-bridge-runtime [run|enroll|healthcheck]");
  }

  const config = loadRuntimeProcessConfig();
  const runtimeVersion = await resolveRuntimeVersion();

  if (command === "enroll") {
    const runtime = new ProductionRuntime({
      ...config,
      runtimeVersion,
    });
    const token = await readEnrollmentToken(process.env);
    const binding = await runtime.enroll(token);
    process.stdout.write(
      `${JSON.stringify({
        status: "enrolled",
        tenantId: binding.tenantId,
        installationId: binding.installationId,
        bridgeInstanceId: binding.bridgeInstanceId,
        keyId: binding.keyId,
      })}\n`,
    );
    return;
  }

  await runRuntime(config, runtimeVersion);
}

async function runRuntime(
  config: RuntimeProcessConfig,
  runtimeVersion: string,
): Promise<void> {
  const statusStore = new FileRuntimeProcessStatusStore(
    join(config.stateDir, "runtime", "status.json"),
  );
  const controller = new AbortController();
  let state: RuntimeReadiness | "starting" = "starting";
  let statusWrite: Promise<void> = Promise.resolve();

  const queueStatusWrite = (): void => {
    statusWrite = statusWrite
      .catch(() => undefined)
      .then(async () => {
        await statusStore.write(state, runtimeVersion);
      });
    statusWrite.catch(() => controller.abort());
  };

  const onSignal = (): void => controller.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  await statusStore.write("starting", runtimeVersion);

  const heartbeat = setInterval(queueStatusWrite, STATUS_HEARTBEAT_MS);
  heartbeat.unref();

  const runtime = new ProductionRuntime({
    ...config,
    runtimeVersion,
    onReadinessChange: (readiness) => {
      state = readiness;
      queueStatusWrite();
    },
    onRecoverableError: (source, retryDelayMs) => {
      process.stderr.write(
        `${JSON.stringify({
          level: "warn",
          event: "runtime_recoverable_error",
          source,
          retryDelayMs,
        })}\n`,
      );
    },
  });

  try {
    await runtime.run(controller.signal);
    await statusWrite.catch(() => undefined);
    await statusStore.write("stopped", runtimeVersion);
  } catch (error) {
    await statusWrite.catch(() => undefined);
    await statusStore.write("failed", runtimeVersion).catch(() => undefined);
    throw error;
  } finally {
    clearInterval(heartbeat);
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}

async function readEnrollmentToken(env: NodeJS.ProcessEnv): Promise<string> {
  const direct = env.KAB_ENROLLMENT_TOKEN?.trim();
  const filePath = env.KAB_ENROLLMENT_TOKEN_FILE?.trim();

  if (direct && filePath) {
    throw new Error(
      "Set only one of KAB_ENROLLMENT_TOKEN or KAB_ENROLLMENT_TOKEN_FILE.",
    );
  }

  let token = direct;
  if (!token && filePath) {
    const raw = await readFile(resolve(filePath), "utf8");
    if (raw.length > 16_384) {
      throw new Error("Enrollment token file is unexpectedly large.");
    }
    token = raw.trim();
  }

  if (!token) {
    throw new Error(
      "Enrollment requires KAB_ENROLLMENT_TOKEN or KAB_ENROLLMENT_TOKEN_FILE.",
    );
  }
  return token;
}

async function resolveRuntimeVersion(): Promise<string> {
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

  throw new Error("Unable to resolve Agent Bridge package version.");
}

function isFileNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown runtime error.";
  process.stderr.write(
    `${JSON.stringify({ level: "error", event: "runtime_exit", message })}\n`,
  );
  process.exitCode = 1;
});

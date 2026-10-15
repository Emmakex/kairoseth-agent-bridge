import { resolve } from "node:path";

import type { RuntimeDeploymentMode } from "../identity/installation-identity.js";

export interface RuntimeProcessConfig {
  platformBaseUrl: string;
  stateDir: string;
  deploymentMode: RuntimeDeploymentMode;
  allowInsecureHttp: boolean;
}

const DEFAULT_STATE_DIR = "/var/lib/agent-bridge";

export function loadRuntimeProcessConfig(
  env: NodeJS.ProcessEnv = process.env,
): RuntimeProcessConfig {
  const platformBaseUrl = requiredEnv(env, "KAB_PLATFORM_BASE_URL");
  const url = new URL(platformBaseUrl);

  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      "KAB_PLATFORM_BASE_URL must not contain credentials, query, or fragment.",
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("KAB_PLATFORM_BASE_URL must use HTTP(S).");
  }

  const deploymentMode = parseDeploymentMode(env.KAB_DEPLOYMENT_MODE);
  const allowInsecureHttp = parseBooleanEnv(env.KAB_ALLOW_INSECURE_HTTP, false);

  const localhost =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1";
  if (url.protocol !== "https:" && !(localhost || allowInsecureHttp)) {
    throw new Error(
      "KAB_PLATFORM_BASE_URL requires HTTPS outside localhost unless KAB_ALLOW_INSECURE_HTTP=true is explicitly set for a controlled environment.",
    );
  }

  const stateDir = resolve(env.KAB_STATE_DIR?.trim() || DEFAULT_STATE_DIR);
  if (stateDir === "/") {
    throw new Error("KAB_STATE_DIR must not be the filesystem root.");
  }

  return {
    platformBaseUrl: url.toString(),
    stateDir,
    deploymentMode,
    allowInsecureHttp,
  };
}

export function parseDeploymentMode(
  value: string | undefined,
): RuntimeDeploymentMode {
  const normalized = value?.trim() || "local";
  if (
    normalized === "hosted" ||
    normalized === "local" ||
    normalized === "hybrid" ||
    normalized === "embedded"
  ) {
    return normalized;
  }

  throw new Error(
    "KAB_DEPLOYMENT_MODE must be hosted, local, hybrid, or embedded.",
  );
}

export function parseBooleanEnv(
  value: string | undefined,
  fallback: boolean,
): boolean {
  if (value === undefined || !value.trim()) return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  throw new Error("Boolean environment values must be true/false or 1/0.");
}

function requiredEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required.`);
  return value;
}

import type { RuntimeProcessStatus } from "./process-status.js";

export type OperatorLocale = "es" | "en";

export interface RuntimeOperatorStatusSnapshot {
  status: RuntimeProcessStatus | null;
  healthy: boolean;
}

const COPY = {
  es: {
    title: "Agent Bridge — estado del runtime",
    noStatus: "Todavía no hay estado del runtime.",
    state: "Estado",
    health: "Salud",
    version: "Versión",
    pid: "PID",
    updated: "Actualizado",
    healthy: "Correcta",
    unhealthy: "No saludable",
    states: {
      starting: "Iniciando",
      ready: "Listo",
      degraded: "Degradado",
      stopped: "Detenido",
      failed: "Fallido",
    },
  },
  en: {
    title: "Agent Bridge — runtime status",
    noStatus: "No runtime status is available yet.",
    state: "State",
    health: "Health",
    version: "Version",
    pid: "PID",
    updated: "Updated",
    healthy: "Healthy",
    unhealthy: "Unhealthy",
    states: {
      starting: "Starting",
      ready: "Ready",
      degraded: "Degraded",
      stopped: "Stopped",
      failed: "Failed",
    },
  },
} as const;

export function normalizeOperatorLocale(value: string | undefined): OperatorLocale {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "en") return "en";
  if (normalized === "es") return "es";
  throw new Error("Operator locale must be 'es' or 'en'.");
}

export function resolveOperatorLocale(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): OperatorLocale {
  let requested: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) break;

    if (argument === "--locale") {
      if (requested !== undefined) {
        throw new Error("Operator locale may only be specified once.");
      }
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--locale requires 'es' or 'en'.");
      }
      requested = value;
      index += 1;
      continue;
    }

    if (argument.startsWith("--locale=")) {
      if (requested !== undefined) {
        throw new Error("Operator locale may only be specified once.");
      }
      requested = argument.slice("--locale=".length);
      continue;
    }

    throw new Error(`Unknown status option: ${argument}`);
  }

  return normalizeOperatorLocale(requested ?? env.KAB_OPERATOR_LOCALE);
}

export function renderRuntimeOperatorStatus(
  snapshot: RuntimeOperatorStatusSnapshot,
  locale: OperatorLocale,
): string {
  const copy = COPY[locale];
  const lines: string[] = [copy.title];

  if (!snapshot.status) {
    lines.push(copy.noStatus);
    return `${lines.join("\n")}\n`;
  }

  lines.push(`${copy.state}: ${copy.states[snapshot.status.state]}`);
  lines.push(`${copy.health}: ${snapshot.healthy ? copy.healthy : copy.unhealthy}`);
  lines.push(`${copy.version}: ${snapshot.status.runtimeVersion}`);
  lines.push(`${copy.pid}: ${snapshot.status.pid}`);
  lines.push(`${copy.updated}: ${snapshot.status.updatedAt}`);

  return `${lines.join("\n")}\n`;
}

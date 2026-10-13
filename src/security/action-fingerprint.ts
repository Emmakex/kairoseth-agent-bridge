import { createHash } from "node:crypto";

import { canonicalJson } from "./canonical-json.js";

export interface ActionFingerprintInput {
  tenantId: string;
  installationId: string;
  toolId: string;
  correlationId: string;
  input: unknown;
}

export function createActionFingerprint(value: ActionFingerprintInput): string {
  const payload = canonicalJson({
    version: "kab.action.v1",
    tenantId: value.tenantId,
    installationId: value.installationId,
    toolId: value.toolId,
    correlationId: value.correlationId,
    input: value.input,
  });

  return createHash("sha256").update(payload, "utf8").digest("base64url");
}

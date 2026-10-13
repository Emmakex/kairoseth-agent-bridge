import { createPublicKey, verify as verifySignature } from "node:crypto";

import { createActionFingerprint } from "./action-fingerprint.js";

export type ApprovalDecision = "ALLOW" | "DENY";

export interface ApprovalPayload {
  version: "kab.approval.v1";
  decision: ApprovalDecision;
  tenantId: string;
  installationId: string;
  toolId: string;
  correlationId: string;
  actionFingerprint: string;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
}

export interface ApprovalVerificationRequest {
  tenantId: string;
  installationId: string;
  toolId: string;
  correlationId: string;
  input: unknown;
}

export type ApprovalPublicKeyResolver = (
  keyId: string,
) => Promise<string | Buffer | null>;

export type ApprovalVerificationResult =
  | {
      valid: true;
      decision: ApprovalDecision;
      payload: ApprovalPayload;
      reason: string;
    }
  | {
      valid: false;
      reason: string;
    };

export interface SignedApprovalVerifierOptions {
  resolvePublicKey: ApprovalPublicKeyResolver;
  now?: () => Date;
  maxClockSkewMs?: number;
}

interface ParsedApprovalToken {
  keyId: string;
  payload: ApprovalPayload;
  signingInput: string;
  signature: Buffer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parsePayload(value: unknown): ApprovalPayload | null {
  if (!isRecord(value)) {
    return null;
  }

  if (value.version !== "kab.approval.v1") {
    return null;
  }

  if (value.decision !== "ALLOW" && value.decision !== "DENY") {
    return null;
  }

  const requiredStrings = [
    "tenantId",
    "installationId",
    "toolId",
    "correlationId",
    "actionFingerprint",
    "issuedAt",
    "expiresAt",
    "nonce",
  ] as const;

  for (const field of requiredStrings) {
    if (typeof value[field] !== "string" || value[field].length === 0) {
      return null;
    }
  }

  return {
    version: "kab.approval.v1",
    decision: value.decision,
    tenantId: value.tenantId as string,
    installationId: value.installationId as string,
    toolId: value.toolId as string,
    correlationId: value.correlationId as string,
    actionFingerprint: value.actionFingerprint as string,
    issuedAt: value.issuedAt as string,
    expiresAt: value.expiresAt as string,
    nonce: value.nonce as string,
  };
}

function parseToken(token: string): ParsedApprovalToken | null {
  if (token.length === 0 || token.length > 16_384) {
    return null;
  }

  const segments = token.split(".");

  if (segments.length !== 4 || segments[0] !== "kab1") {
    return null;
  }

  const [, keyIdSegment, payloadSegment, signatureSegment] = segments;

  if (!keyIdSegment || !payloadSegment || !signatureSegment) {
    return null;
  }

  try {
    const keyId = Buffer.from(keyIdSegment, "base64url").toString("utf8");
    const payloadText = Buffer.from(payloadSegment, "base64url").toString("utf8");
    const payload = parsePayload(JSON.parse(payloadText) as unknown);
    const signature = Buffer.from(signatureSegment, "base64url");

    if (!keyId || !payload || signature.length === 0) {
      return null;
    }

    return {
      keyId,
      payload,
      signingInput: `kab1.${keyIdSegment}.${payloadSegment}`,
      signature,
    };
  } catch {
    return null;
  }
}

export class SignedApprovalVerifier {
  private readonly resolvePublicKey: ApprovalPublicKeyResolver;
  private readonly now: () => Date;
  private readonly maxClockSkewMs: number;

  constructor(options: SignedApprovalVerifierOptions) {
    this.resolvePublicKey = options.resolvePublicKey;
    this.now = options.now ?? (() => new Date());
    this.maxClockSkewMs = options.maxClockSkewMs ?? 30_000;
  }

  async verify(
    token: string,
    request: ApprovalVerificationRequest,
  ): Promise<ApprovalVerificationResult> {
    const parsed = parseToken(token);

    if (!parsed) {
      return { valid: false, reason: "Malformed approval token." };
    }

    let publicKey: string | Buffer | null;

    try {
      publicKey = await this.resolvePublicKey(parsed.keyId);
    } catch {
      return { valid: false, reason: "Approval signing key lookup failed." };
    }

    if (!publicKey) {
      return { valid: false, reason: "Unknown approval signing key." };
    }

    let signatureValid = false;

    try {
      signatureValid = verifySignature(
        null,
        Buffer.from(parsed.signingInput, "utf8"),
        createPublicKey(publicKey),
        parsed.signature,
      );
    } catch {
      return { valid: false, reason: "Invalid approval signing key." };
    }

    if (!signatureValid) {
      return { valid: false, reason: "Invalid approval signature." };
    }

    const { payload } = parsed;

    if (
      payload.tenantId !== request.tenantId ||
      payload.installationId !== request.installationId ||
      payload.toolId !== request.toolId ||
      payload.correlationId !== request.correlationId
    ) {
      return {
        valid: false,
        reason: "Approval scope does not match the requested invocation.",
      };
    }

    const expectedFingerprint = createActionFingerprint(request);

    if (payload.actionFingerprint !== expectedFingerprint) {
      return {
        valid: false,
        reason: "Approval fingerprint does not match the requested action.",
      };
    }

    const issuedAt = Date.parse(payload.issuedAt);
    const expiresAt = Date.parse(payload.expiresAt);

    if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) {
      return { valid: false, reason: "Approval timestamps are invalid." };
    }

    if (expiresAt <= issuedAt) {
      return { valid: false, reason: "Approval expiration is invalid." };
    }

    const now = this.now().getTime();

    if (issuedAt > now + this.maxClockSkewMs) {
      return { valid: false, reason: "Approval was issued in the future." };
    }

    if (expiresAt < now - this.maxClockSkewMs) {
      return { valid: false, reason: "Approval has expired." };
    }

    return {
      valid: true,
      decision: payload.decision,
      payload,
      reason:
        payload.decision === "ALLOW"
          ? "Signed approval is valid for this invocation."
          : "Signed approval explicitly denies this invocation.",
    };
  }
}

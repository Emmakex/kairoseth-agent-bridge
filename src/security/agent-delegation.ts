import { Buffer } from "node:buffer";
import { createPublicKey, verify as verifySignature } from "node:crypto";

import type { RiskLevel } from "../core/contracts.js";

const TOKEN_PREFIX = "kabd1";
const PAYLOAD_VERSION = "kab.agent-delegation.v1" as const;
const AUDIENCE = "kairoseth-agent-bridge" as const;
const MAX_TOKEN_LENGTH = 16_384;
const MAX_ID_LENGTH = 256;
const MAX_ACTOR_LENGTH = 512;
const MAX_TOOL_COUNT = 256;
const DEFAULT_MAX_CLOCK_SKEW_MS = 30_000;
const DEFAULT_MAX_GRANT_LIFETIME_MS = 24 * 60 * 60 * 1_000;

export interface AgentDelegationPayload {
  version: typeof PAYLOAD_VERSION;
  audience: typeof AUDIENCE;
  delegationId: string;
  tenantId: string;
  installationId: string;
  delegatorActor: string;
  delegateActor: string;
  toolIds: readonly string[];
  maxRisk: RiskLevel;
  issuedAt: string;
  expiresAt: string;
}

export interface AgentDelegationVerificationRequest {
  tenantId: string;
  installationId: string;
  delegateActor: string;
  toolId: string;
  risk: RiskLevel;
}

export type DelegationPublicKeyResolver = (
  keyId: string,
) => Promise<string | Buffer | null>;

export type DelegationRevocationChecker = (
  delegationId: string,
) => Promise<boolean>;

export interface SignedAgentDelegationVerifierOptions {
  resolvePublicKey: DelegationPublicKeyResolver;
  isRevoked?: DelegationRevocationChecker | undefined;
  now?: (() => Date) | undefined;
  maxClockSkewMs?: number | undefined;
  maxGrantLifetimeMs?: number | undefined;
}

export type AgentDelegationVerificationResult =
  | {
      valid: true;
      payload: AgentDelegationPayload;
      reason: string;
    }
  | {
      valid: false;
      reason: string;
    };

interface ParsedDelegationToken {
  keyId: string;
  payload: AgentDelegationPayload;
  signingInput: string;
  signature: Buffer;
}

export class SignedAgentDelegationVerifier {
  private readonly resolvePublicKey: DelegationPublicKeyResolver;
  private readonly isRevoked: DelegationRevocationChecker | undefined;
  private readonly now: () => Date;
  private readonly maxClockSkewMs: number;
  private readonly maxGrantLifetimeMs: number;

  constructor(options: SignedAgentDelegationVerifierOptions) {
    this.resolvePublicKey = options.resolvePublicKey;
    this.isRevoked = options.isRevoked;
    this.now = options.now ?? (() => new Date());
    this.maxClockSkewMs = options.maxClockSkewMs ?? DEFAULT_MAX_CLOCK_SKEW_MS;
    this.maxGrantLifetimeMs =
      options.maxGrantLifetimeMs ?? DEFAULT_MAX_GRANT_LIFETIME_MS;

    if (!Number.isFinite(this.maxClockSkewMs) || this.maxClockSkewMs < 0) {
      throw new Error("Delegation maxClockSkewMs must be non-negative.");
    }
    if (
      !Number.isFinite(this.maxGrantLifetimeMs) ||
      this.maxGrantLifetimeMs <= 0
    ) {
      throw new Error("Delegation maxGrantLifetimeMs must be positive.");
    }
  }

  async verify(
    token: string,
    request: AgentDelegationVerificationRequest,
  ): Promise<AgentDelegationVerificationResult> {
    const parsed = parseToken(token);
    if (!parsed) {
      return { valid: false, reason: "Malformed agent delegation token." };
    }

    let publicKey: string | Buffer | null;
    try {
      publicKey = await this.resolvePublicKey(parsed.keyId);
    } catch {
      return {
        valid: false,
        reason: "Delegation signing key lookup failed.",
      };
    }
    if (!publicKey) {
      return { valid: false, reason: "Unknown delegation signing key." };
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
      return { valid: false, reason: "Invalid delegation signing key." };
    }
    if (!signatureValid) {
      return { valid: false, reason: "Invalid delegation signature." };
    }

    const payload = parsed.payload;
    if (
      payload.tenantId !== request.tenantId ||
      payload.installationId !== request.installationId ||
      payload.delegateActor !== request.delegateActor
    ) {
      return {
        valid: false,
        reason: "Delegation identity scope does not match the invocation.",
      };
    }

    if (!payload.toolIds.includes(request.toolId)) {
      return {
        valid: false,
        reason: "Delegation does not allow the requested tool.",
      };
    }

    if (riskRank(request.risk) > riskRank(payload.maxRisk)) {
      return {
        valid: false,
        reason: "Delegation does not allow the requested risk level.",
      };
    }

    const issuedAt = Date.parse(payload.issuedAt);
    const expiresAt = Date.parse(payload.expiresAt);
    if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) {
      return { valid: false, reason: "Delegation timestamps are invalid." };
    }
    if (expiresAt <= issuedAt) {
      return { valid: false, reason: "Delegation expiration is invalid." };
    }
    if (expiresAt - issuedAt > this.maxGrantLifetimeMs) {
      return {
        valid: false,
        reason: "Delegation lifetime exceeds the configured maximum.",
      };
    }

    const now = this.now().getTime();
    if (issuedAt > now + this.maxClockSkewMs) {
      return { valid: false, reason: "Delegation was issued in the future." };
    }
    if (expiresAt < now - this.maxClockSkewMs) {
      return { valid: false, reason: "Delegation has expired." };
    }

    if (this.isRevoked) {
      try {
        if (await this.isRevoked(payload.delegationId)) {
          return { valid: false, reason: "Delegation has been revoked." };
        }
      } catch {
        return {
          valid: false,
          reason: "Delegation revocation status is unavailable.",
        };
      }
    }

    return {
      valid: true,
      payload,
      reason: "Signed agent delegation is valid for this invocation.",
    };
  }
}

function parseToken(token: string): ParsedDelegationToken | null {
  if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;
  const segments = token.split(".");
  if (segments.length !== 4 || segments[0] !== TOKEN_PREFIX) return null;

  const [, keyIdSegment, payloadSegment, signatureSegment] = segments;
  if (!keyIdSegment || !payloadSegment || !signatureSegment) return null;

  try {
    const keyId = Buffer.from(keyIdSegment, "base64url").toString("utf8");
    const payloadText = Buffer.from(payloadSegment, "base64url").toString("utf8");
    const payload = parsePayload(JSON.parse(payloadText) as unknown);
    const signature = Buffer.from(signatureSegment, "base64url");
    if (!keyId || !payload || signature.length === 0) return null;

    return {
      keyId,
      payload,
      signingInput: `${TOKEN_PREFIX}.${keyIdSegment}.${payloadSegment}`,
      signature,
    };
  } catch {
    return null;
  }
}

function parsePayload(value: unknown): AgentDelegationPayload | null {
  if (!isRecord(value)) return null;

  const expectedKeys = [
    "audience",
    "delegateActor",
    "delegationId",
    "delegatorActor",
    "expiresAt",
    "installationId",
    "issuedAt",
    "maxRisk",
    "tenantId",
    "toolIds",
    "version",
  ];
  const actualKeys = Object.keys(value).sort(compareStrings);
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    return null;
  }

  if (value.version !== PAYLOAD_VERSION || value.audience !== AUDIENCE) {
    return null;
  }
  if (
    !boundedString(value.delegationId, MAX_ID_LENGTH) ||
    !boundedString(value.tenantId, MAX_ID_LENGTH) ||
    !boundedString(value.installationId, MAX_ID_LENGTH) ||
    !boundedString(value.delegatorActor, MAX_ACTOR_LENGTH) ||
    !boundedString(value.delegateActor, MAX_ACTOR_LENGTH) ||
    !boundedString(value.issuedAt, 64) ||
    !boundedString(value.expiresAt, 64)
  ) {
    return null;
  }
  if (!isRisk(value.maxRisk)) return null;
  if (!Array.isArray(value.toolIds) || value.toolIds.length < 1 || value.toolIds.length > MAX_TOOL_COUNT) {
    return null;
  }

  const toolIds: string[] = [];
  const seen = new Set<string>();
  for (const toolId of value.toolIds) {
    if (!boundedString(toolId, MAX_ID_LENGTH) || seen.has(toolId)) return null;
    seen.add(toolId);
    toolIds.push(toolId);
  }

  return {
    version: PAYLOAD_VERSION,
    audience: AUDIENCE,
    delegationId: value.delegationId,
    tenantId: value.tenantId,
    installationId: value.installationId,
    delegatorActor: value.delegatorActor,
    delegateActor: value.delegateActor,
    toolIds,
    maxRisk: value.maxRisk,
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
  };
}

function riskRank(risk: RiskLevel): number {
  return risk === "READ" ? 0 : risk === "WRITE" ? 1 : 2;
}

function isRisk(value: unknown): value is RiskLevel {
  return value === "READ" || value === "WRITE" || value === "CRITICAL";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

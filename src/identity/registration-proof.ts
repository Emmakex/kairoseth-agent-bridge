import {
  createPrivateKey,
  createPublicKey,
  sign as signPayload,
  verify as verifySignature,
} from "node:crypto";

import { canonicalJson } from "../security/canonical-json.js";
import {
  getBridgePublicKeyFingerprint,
  type RuntimeDeploymentMode,
  type StoredBridgeIdentity,
} from "./installation-identity.js";

export interface RegistrationProofPayload {
  version: "kab.registration.v1";
  bridgeInstanceId: string;
  keyId: string;
  publicKeyPem: string;
  runtimeVersion: string;
  deploymentMode: RuntimeDeploymentMode;
  capabilities: readonly string[];
  nonce: string;
  issuedAt: string;
}

export interface SignedRegistrationProof {
  payload: RegistrationProofPayload;
  signature: string;
}

export interface CreateRegistrationProofOptions {
  runtimeVersion: string;
  deploymentMode: RuntimeDeploymentMode;
  capabilities?: readonly string[];
  nonce: string;
  now?: () => Date;
}

export type RegistrationProofVerificationResult =
  | { valid: true; reason: string }
  | { valid: false; reason: string };

function normalizedCapabilities(capabilities: readonly string[]): string[] {
  return [...new Set(capabilities.map((value) => value.trim()).filter(Boolean))].sort();
}

export function createRegistrationProof(
  identity: StoredBridgeIdentity,
  options: CreateRegistrationProofOptions,
): SignedRegistrationProof {
  const payload: RegistrationProofPayload = {
    version: "kab.registration.v1",
    bridgeInstanceId: identity.bridgeInstanceId,
    keyId: identity.keyId,
    publicKeyPem: identity.publicKeyPem,
    runtimeVersion: options.runtimeVersion,
    deploymentMode: options.deploymentMode,
    capabilities: normalizedCapabilities(options.capabilities ?? []),
    nonce: options.nonce,
    issuedAt: (options.now ?? (() => new Date()))().toISOString(),
  };

  const message = Buffer.from(canonicalJson(payload), "utf8");
  const signature = signPayload(
    null,
    message,
    createPrivateKey(identity.privateKeyPem),
  );

  return {
    payload,
    signature: signature.toString("base64url"),
  };
}

export function verifyRegistrationProof(
  proof: SignedRegistrationProof,
): RegistrationProofVerificationResult {
  const { payload } = proof;

  if (payload.version !== "kab.registration.v1") {
    return { valid: false, reason: "Unsupported registration proof version." };
  }

  if (!payload.bridgeInstanceId || !payload.nonce || !payload.runtimeVersion) {
    return { valid: false, reason: "Registration proof is missing required fields." };
  }

  let fingerprint: string;

  try {
    fingerprint = getBridgePublicKeyFingerprint(payload.publicKeyPem);
  } catch {
    return { valid: false, reason: "Registration public key is invalid." };
  }

  if (fingerprint !== payload.keyId) {
    return { valid: false, reason: "Registration key ID does not match the public key." };
  }

  let signature: Buffer;

  try {
    signature = Buffer.from(proof.signature, "base64url");
  } catch {
    return { valid: false, reason: "Registration signature is malformed." };
  }

  if (signature.length === 0) {
    return { valid: false, reason: "Registration signature is missing." };
  }

  let valid = false;

  try {
    valid = verifySignature(
      null,
      Buffer.from(canonicalJson(payload), "utf8"),
      createPublicKey(payload.publicKeyPem),
      signature,
    );
  } catch {
    return { valid: false, reason: "Registration signature could not be verified." };
  }

  return valid
    ? { valid: true, reason: "Registration proof signature is valid." }
    : { valid: false, reason: "Registration proof signature is invalid." };
}

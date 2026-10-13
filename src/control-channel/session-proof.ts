import {
  createPrivateKey,
  createPublicKey,
  sign as signPayload,
  verify as verifySignature,
} from "node:crypto";

import { canonicalJson } from "../security/canonical-json.js";
import type { StoredBridgeIdentity } from "../identity/installation-identity.js";
import type { InstallationBinding } from "./enrollment.js";

export interface SessionProofPayload {
  version: "kab.session-proof.v1";
  tenantId: string;
  installationId: string;
  bridgeInstanceId: string;
  keyId: string;
  nonce: string;
  issuedAt: string;
}

export interface SignedSessionProof {
  payload: SessionProofPayload;
  signature: string;
}

export function createSessionProof(
  identity: StoredBridgeIdentity,
  binding: InstallationBinding,
  nonce: string,
  now: () => Date = () => new Date(),
): SignedSessionProof {
  if (!nonce) {
    throw new Error("Session challenge nonce is required.");
  }

  if (
    binding.bridgeInstanceId !== identity.bridgeInstanceId ||
    binding.keyId !== identity.keyId
  ) {
    throw new Error("Installation binding does not match the local bridge identity.");
  }

  const payload: SessionProofPayload = {
    version: "kab.session-proof.v1",
    tenantId: binding.tenantId,
    installationId: binding.installationId,
    bridgeInstanceId: identity.bridgeInstanceId,
    keyId: identity.keyId,
    nonce,
    issuedAt: now().toISOString(),
  };

  const signature = signPayload(
    null,
    Buffer.from(canonicalJson(payload), "utf8"),
    createPrivateKey(identity.privateKeyPem),
  );

  return {
    payload,
    signature: signature.toString("base64url"),
  };
}

export function verifySessionProof(
  proof: SignedSessionProof,
  publicKeyPem: string,
): boolean {
  try {
    return verifySignature(
      null,
      Buffer.from(canonicalJson(proof.payload), "utf8"),
      createPublicKey(publicKeyPem),
      Buffer.from(proof.signature, "base64url"),
    );
  } catch {
    return false;
  }
}

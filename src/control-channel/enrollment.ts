import type { BridgeIdentityManager } from "../identity/installation-identity.js";
import { createRegistrationProof } from "../identity/registration-proof.js";
import type {
  RuntimeDeploymentMode,
  StoredBridgeIdentity,
} from "../identity/installation-identity.js";
import type { SignedRegistrationProof } from "../identity/registration-proof.js";
import type { InstallationBindingStore } from "./installation-binding.js";

export interface EnrollmentChallenge {
  version: "kab.enrollment-challenge.v1";
  nonce: string;
  expiresAt: string;
}

export interface TrustedApprovalKey {
  keyId: string;
  publicKeyPem: string;
  notBefore?: string;
  notAfter?: string;
}

export interface InstallationBinding {
  version: "kab.installation-binding.v1";
  tenantId: string;
  installationId: string;
  bridgeInstanceId: string;
  keyId: string;
  registeredAt: string;
  trustedApprovalKeys: readonly TrustedApprovalKey[];
}

export interface OutboundEnrollmentTransport {
  requestChallenge(enrollmentToken: string): Promise<EnrollmentChallenge>;
  register(
    enrollmentToken: string,
    proof: SignedRegistrationProof,
  ): Promise<InstallationBinding>;
}

export interface InstallationEnrollmentOptions {
  runtimeVersion: string;
  deploymentMode: RuntimeDeploymentMode;
  capabilities?: readonly string[];
  bindingStore?: InstallationBindingStore | undefined;
  now?: () => Date;
}

export class InstallationEnrollmentClient {
  private readonly now: () => Date;

  constructor(
    private readonly identityManager: BridgeIdentityManager,
    private readonly transport: OutboundEnrollmentTransport,
    private readonly options: InstallationEnrollmentOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async enroll(enrollmentToken: string): Promise<InstallationBinding> {
    if (!enrollmentToken.trim()) {
      throw new Error("Enrollment token is required.");
    }

    const identity = await this.identityManager.getOrCreate();
    const challenge = await this.transport.requestChallenge(enrollmentToken);
    this.validateChallenge(challenge);

    const proof = createRegistrationProof(identity, {
      runtimeVersion: this.options.runtimeVersion,
      deploymentMode: this.options.deploymentMode,
      capabilities: this.options.capabilities,
      nonce: challenge.nonce,
      now: this.now,
    });

    const binding = await this.transport.register(enrollmentToken, proof);
    this.validateBinding(identity, binding);

    if (this.options.bindingStore) {
      await this.options.bindingStore.save(binding);
    }

    return binding;
  }

  private validateChallenge(challenge: EnrollmentChallenge): void {
    if (challenge.version !== "kab.enrollment-challenge.v1") {
      throw new Error("Unsupported enrollment challenge version.");
    }

    if (!challenge.nonce) {
      throw new Error("Enrollment challenge nonce is missing.");
    }

    const expiresAt = Date.parse(challenge.expiresAt);

    if (!Number.isFinite(expiresAt)) {
      throw new Error("Enrollment challenge expiration is invalid.");
    }

    if (expiresAt <= this.now().getTime()) {
      throw new Error("Enrollment challenge has expired.");
    }
  }

  private validateBinding(
    identity: StoredBridgeIdentity,
    binding: InstallationBinding,
  ): void {
    if (binding.version !== "kab.installation-binding.v1") {
      throw new Error("Unsupported installation binding version.");
    }

    if (!binding.tenantId || !binding.installationId) {
      throw new Error("Installation binding is missing platform scope.");
    }

    if (binding.bridgeInstanceId !== identity.bridgeInstanceId) {
      throw new Error("Installation binding targets a different bridge instance.");
    }

    if (binding.keyId !== identity.keyId) {
      throw new Error("Installation binding targets a different bridge key.");
    }
  }
}

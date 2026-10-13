import type { BridgeIdentityManager } from "../identity/installation-identity.js";
import type { InstallationBinding } from "./enrollment.js";
import { createSessionProof, type SignedSessionProof } from "./session-proof.js";

export type RuntimeReadiness = "starting" | "ready" | "degraded";

export interface SessionChallenge {
  version: "kab.session-challenge.v1";
  nonce: string;
  expiresAt: string;
}

export interface SessionCredential {
  version: "kab.session-credential.v1";
  sessionId: string;
  tenantId: string;
  installationId: string;
  bridgeInstanceId: string;
  keyId: string;
  accessToken: string;
  issuedAt: string;
  expiresAt: string;
  heartbeatIntervalSeconds: number;
}

export interface HeartbeatPayload {
  version: "kab.heartbeat.v1";
  sessionId: string;
  tenantId: string;
  installationId: string;
  bridgeInstanceId: string;
  sentAt: string;
  readiness: RuntimeReadiness;
  runtimeVersion: string;
  capabilities: readonly string[];
}

export interface HeartbeatAck {
  version: "kab.heartbeat-ack.v1";
  receivedAt: string;
  nextHeartbeatInSeconds?: number;
}

export interface OutboundSessionTransport {
  requestSessionChallenge(
    binding: InstallationBinding,
  ): Promise<SessionChallenge>;
  openSession(proof: SignedSessionProof): Promise<SessionCredential>;
  sendHeartbeat(
    accessToken: string,
    heartbeat: HeartbeatPayload,
  ): Promise<HeartbeatAck>;
}

export interface ControlSessionOptions {
  runtimeVersion: string;
  capabilities?: readonly string[] | undefined;
  now?: (() => Date) | undefined;
}

function normalizeCapabilities(capabilities: readonly string[]): string[] {
  return [...new Set(capabilities.map((value) => value.trim()).filter(Boolean))].sort();
}

export class ControlSession {
  private readonly capabilities: readonly string[];
  private readonly now: () => Date;

  constructor(
    readonly credential: SessionCredential,
    private readonly transport: OutboundSessionTransport,
    private readonly options: ControlSessionOptions,
  ) {
    this.capabilities = normalizeCapabilities(options.capabilities ?? []);
    this.now = options.now ?? (() => new Date());
  }

  isExpired(): boolean {
    return Date.parse(this.credential.expiresAt) <= this.now().getTime();
  }

  async heartbeat(readiness: RuntimeReadiness): Promise<HeartbeatAck> {
    if (this.isExpired()) {
      throw new Error("Control session credential has expired.");
    }

    const payload: HeartbeatPayload = {
      version: "kab.heartbeat.v1",
      sessionId: this.credential.sessionId,
      tenantId: this.credential.tenantId,
      installationId: this.credential.installationId,
      bridgeInstanceId: this.credential.bridgeInstanceId,
      sentAt: this.now().toISOString(),
      readiness,
      runtimeVersion: this.options.runtimeVersion,
      capabilities: this.capabilities,
    };

    return this.transport.sendHeartbeat(this.credential.accessToken, payload);
  }
}

export class ControlSessionClient {
  private readonly now: () => Date;

  constructor(
    private readonly identityManager: BridgeIdentityManager,
    private readonly transport: OutboundSessionTransport,
    private readonly options: ControlSessionOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async open(binding: InstallationBinding): Promise<ControlSession> {
    const identity = await this.identityManager.getOrCreate();
    const challenge = await this.transport.requestSessionChallenge(binding);
    this.validateChallenge(challenge);

    const proof = createSessionProof(
      identity,
      binding,
      challenge.nonce,
      this.now,
    );
    const credential = await this.transport.openSession(proof);
    this.validateCredential(binding, credential);

    return new ControlSession(credential, this.transport, this.options);
  }

  private validateChallenge(challenge: SessionChallenge): void {
    if (challenge.version !== "kab.session-challenge.v1") {
      throw new Error("Unsupported session challenge version.");
    }

    if (!challenge.nonce) {
      throw new Error("Session challenge nonce is missing.");
    }

    const expiresAt = Date.parse(challenge.expiresAt);

    if (!Number.isFinite(expiresAt) || expiresAt <= this.now().getTime()) {
      throw new Error("Session challenge has expired or is invalid.");
    }
  }

  private validateCredential(
    binding: InstallationBinding,
    credential: SessionCredential,
  ): void {
    if (credential.version !== "kab.session-credential.v1") {
      throw new Error("Unsupported session credential version.");
    }

    if (!credential.sessionId || !credential.accessToken) {
      throw new Error("Session credential is incomplete.");
    }

    if (
      credential.tenantId !== binding.tenantId ||
      credential.installationId !== binding.installationId ||
      credential.bridgeInstanceId !== binding.bridgeInstanceId ||
      credential.keyId !== binding.keyId
    ) {
      throw new Error("Session credential scope does not match the installation binding.");
    }

    const issuedAt = Date.parse(credential.issuedAt);
    const expiresAt = Date.parse(credential.expiresAt);

    if (
      !Number.isFinite(issuedAt) ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= issuedAt ||
      expiresAt <= this.now().getTime()
    ) {
      throw new Error("Session credential lifetime is invalid or expired.");
    }

    if (
      !Number.isInteger(credential.heartbeatIntervalSeconds) ||
      credential.heartbeatIntervalSeconds < 5 ||
      credential.heartbeatIntervalSeconds > 3600
    ) {
      throw new Error("Session heartbeat interval is invalid.");
    }
  }
}

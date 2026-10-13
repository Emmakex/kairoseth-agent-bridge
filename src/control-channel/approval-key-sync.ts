import type { ApprovalKeySetManager, SignedApprovalKeySet } from "../security/approval-keys.js";
import type { ControlSession } from "./session.js";

export interface ApprovalKeySetTransport {
  fetchApprovalKeySet(
    accessToken: string,
    sessionId: string,
    currentGeneration: number,
  ): Promise<SignedApprovalKeySet | null>;
}

export interface ApprovalKeySyncResult {
  changed: boolean;
  generation: number;
}

export class ApprovalKeySetSyncClient {
  constructor(
    private readonly session: ControlSession,
    private readonly manager: ApprovalKeySetManager,
    private readonly transport: ApprovalKeySetTransport,
  ) {}

  async syncOnce(): Promise<ApprovalKeySyncResult> {
    if (this.session.isExpired()) {
      throw new Error("Cannot synchronize approval keys with an expired control session.");
    }

    const current = await this.manager.getOrBootstrap();
    const { credential } = this.session;
    const update = await this.transport.fetchApprovalKeySet(
      credential.accessToken,
      credential.sessionId,
      current.generation,
    );

    if (!update) {
      return {
        changed: false,
        generation: current.generation,
      };
    }

    const next = await this.manager.apply(update);
    return {
      changed: true,
      generation: next.generation,
    };
  }
}

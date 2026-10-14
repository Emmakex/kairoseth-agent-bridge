import type { BridgeRuntime } from "../runtime/bridge-runtime.js";
import { createActionFingerprint } from "../security/action-fingerprint.js";
import type { SessionCredential } from "./session.js";
import type {
  CommandCompletedReceipt,
  CommandOutcomeStatus,
  CommandReceipt,
  CommandReceiptStore,
} from "./command-receipts.js";

export interface CommandEnvelope {
  version: "kab.command.v1";
  commandId: string;
  deliveryAttempt: number;
  tenantId: string;
  installationId: string;
  bridgeInstanceId: string;
  correlationId: string;
  actor: string;
  toolId: string;
  input: unknown;
  actionFingerprint: string;
  approvalToken?: string | undefined;
  issuedAt: string;
  expiresAt: string;
}

export type CommandAckStatus =
  | CommandOutcomeStatus
  | "duplicate"
  | "indeterminate";

export interface CommandAcknowledgement {
  version: "kab.command-ack.v1";
  commandId: string;
  deliveryAttempt: number;
  sessionId: string;
  correlationId: string;
  status: CommandAckStatus;
  completedAt: string;
  originalOutcome?: CommandOutcomeStatus | undefined;
  reason?: string | undefined;
  output?: unknown;
}

export interface CommandProcessorOptions {
  now?: (() => Date) | undefined;
  maxClockSkewMs?: number | undefined;
  receiptRetentionMs?: number | undefined;
}

const DEFAULT_CLOCK_SKEW_MS = 30_000;
const DEFAULT_RECEIPT_RETENTION_MS = 24 * 60 * 60 * 1_000;

export class CommandProcessor {
  private readonly now: () => Date;
  private readonly maxClockSkewMs: number;
  private readonly receiptRetentionMs: number;

  constructor(
    private readonly runtime: BridgeRuntime,
    private readonly receipts: CommandReceiptStore,
    private readonly options: CommandProcessorOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.maxClockSkewMs = options.maxClockSkewMs ?? DEFAULT_CLOCK_SKEW_MS;
    this.receiptRetentionMs =
      options.receiptRetentionMs ?? DEFAULT_RECEIPT_RETENTION_MS;

    if (this.maxClockSkewMs < 0 || this.receiptRetentionMs <= 0) {
      throw new Error("Invalid command processor timing configuration.");
    }
  }

  async process(
    command: CommandEnvelope,
    credential: SessionCredential,
  ): Promise<CommandAcknowledgement> {
    const now = this.now();
    const validationError = this.validateCommand(command, credential, now);

    if (validationError) {
      return this.ack(command, credential, "rejected", now, validationError);
    }

    const processingReceipt = {
      version: "kab.command-receipt.v1" as const,
      commandId: command.commandId,
      actionFingerprint: command.actionFingerprint,
      state: "processing" as const,
      startedAt: now.toISOString(),
      retainUntil: this.retainUntil(command, now).toISOString(),
    };

    const claim = await this.receipts.claim(processingReceipt);
    if (!claim.claimed) {
      return this.ackExisting(command, credential, claim.receipt, now);
    }

    const expiresAt = Date.parse(command.expiresAt);
    if (expiresAt <= now.getTime()) {
      const receipt = this.completedReceipt(command, "expired", now, now);
      await this.receipts.complete(receipt);
      return this.ack(
        command,
        credential,
        "expired",
        now,
        "Command expired before execution.",
      );
    }

    let result;

    try {
      const context = {
        correlationId: command.correlationId,
        actor: command.actor,
        tenantId: command.tenantId,
        installationId: command.installationId,
        ...(command.approvalToken
          ? { approvalToken: command.approvalToken }
          : {}),
      };

      result = await this.runtime.invoke(command.toolId, command.input, context);
    } catch (error) {
      const completedAt = this.now();
      const reason = error instanceof Error ? error.message : "Command execution failed.";
      await this.receipts.complete(
        this.completedReceipt(command, "failed", now, completedAt),
      );
      return this.ack(
        command,
        credential,
        "failed",
        completedAt,
        reason,
      );
    }

    const completedAt = this.now();
    const outcome = mapInvocationStatus(result.status);
    await this.receipts.complete(
      this.completedReceipt(command, outcome, now, completedAt),
    );

    if (result.status === "executed") {
      return {
        ...this.ackBase(command, credential, outcome, completedAt),
        output: result.output,
      };
    }

    if (result.status === "approval_required" || result.status === "denied") {
      return this.ack(
        command,
        credential,
        outcome,
        completedAt,
        result.reason,
      );
    }

    return this.ack(
      command,
      credential,
      outcome,
      completedAt,
      result.error,
    );
  }

  private validateCommand(
    command: CommandEnvelope,
    credential: SessionCredential,
    now: Date,
  ): string | null {
    if (command.version !== "kab.command.v1") {
      return "Unsupported command version.";
    }

    if (
      !command.commandId ||
      !command.correlationId ||
      !command.actor ||
      !command.toolId
    ) {
      return "Command is missing required identifiers.";
    }

    if (!Number.isInteger(command.deliveryAttempt) || command.deliveryAttempt < 1) {
      return "Command delivery attempt is invalid.";
    }

    if (
      command.tenantId !== credential.tenantId ||
      command.installationId !== credential.installationId ||
      command.bridgeInstanceId !== credential.bridgeInstanceId
    ) {
      return "Command scope does not match the active control session.";
    }

    const issuedAt = Date.parse(command.issuedAt);
    const expiresAt = Date.parse(command.expiresAt);

    if (
      !Number.isFinite(issuedAt) ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= issuedAt
    ) {
      return "Command lifetime is invalid.";
    }

    if (issuedAt > now.getTime() + this.maxClockSkewMs) {
      return "Command was issued too far in the future.";
    }

    const expectedFingerprint = createActionFingerprint({
      tenantId: command.tenantId,
      installationId: command.installationId,
      toolId: command.toolId,
      correlationId: command.correlationId,
      input: command.input,
    });

    if (expectedFingerprint !== command.actionFingerprint) {
      return "Command action fingerprint is invalid.";
    }

    return null;
  }

  private ackExisting(
    command: CommandEnvelope,
    credential: SessionCredential,
    receipt: CommandReceipt,
    now: Date,
  ): CommandAcknowledgement {
    if (receipt.actionFingerprint !== command.actionFingerprint) {
      return this.ack(
        command,
        credential,
        "rejected",
        now,
        "Command ID was reused for a different action fingerprint.",
      );
    }

    if (receipt.state === "processing") {
      return this.ack(
        command,
        credential,
        "indeterminate",
        now,
        "A previous execution started but did not record completion; automatic re-execution is blocked.",
      );
    }

    return {
      ...this.ackBase(command, credential, "duplicate", now),
      originalOutcome: receipt.outcome,
      reason: "Command was already completed and will not be executed again.",
    };
  }

  private completedReceipt(
    command: CommandEnvelope,
    outcome: CommandOutcomeStatus,
    startedAt: Date,
    completedAt: Date,
  ): CommandCompletedReceipt {
    return {
      version: "kab.command-receipt.v1",
      commandId: command.commandId,
      actionFingerprint: command.actionFingerprint,
      state: "completed",
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      retainUntil: this.retainUntil(command, completedAt).toISOString(),
      outcome,
    };
  }

  private retainUntil(command: CommandEnvelope, reference: Date): Date {
    const commandExpiry = Date.parse(command.expiresAt);
    return new Date(
      Math.max(reference.getTime(), commandExpiry) + this.receiptRetentionMs,
    );
  }

  private ack(
    command: CommandEnvelope,
    credential: SessionCredential,
    status: CommandAckStatus,
    completedAt: Date,
    reason?: string,
  ): CommandAcknowledgement {
    return {
      ...this.ackBase(command, credential, status, completedAt),
      ...(reason ? { reason } : {}),
    };
  }

  private ackBase(
    command: CommandEnvelope,
    credential: SessionCredential,
    status: CommandAckStatus,
    completedAt: Date,
  ): CommandAcknowledgement {
    return {
      version: "kab.command-ack.v1",
      commandId: command.commandId,
      deliveryAttempt: command.deliveryAttempt,
      sessionId: credential.sessionId,
      correlationId: command.correlationId,
      status,
      completedAt: completedAt.toISOString(),
    };
  }
}

function mapInvocationStatus(
  status: "executed" | "approval_required" | "denied" | "failed",
): CommandOutcomeStatus {
  return status;
}

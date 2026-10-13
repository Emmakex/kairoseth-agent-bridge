import { CommandProcessor, type CommandAcknowledgement, type CommandEnvelope } from "./command.js";
import type { ControlSession } from "./session.js";

export interface CommandBatch {
  version: "kab.command-batch.v1";
  batchId: string;
  sessionId: string;
  commands: readonly CommandEnvelope[];
}

export interface OutboundCommandTransport {
  fetchCommands(
    accessToken: string,
    sessionId: string,
    limit: number,
  ): Promise<CommandBatch>;
  acknowledgeCommand(
    accessToken: string,
    acknowledgement: CommandAcknowledgement,
  ): Promise<void>;
}

export interface CommandDeliveryOptions {
  maxBatchSize?: number | undefined;
}

export interface CommandDrainResult {
  batchId: string;
  acknowledgements: readonly CommandAcknowledgement[];
}

export class CommandDeliveryClient {
  private readonly maxBatchSize: number;

  constructor(
    private readonly session: ControlSession,
    private readonly transport: OutboundCommandTransport,
    private readonly processor: CommandProcessor,
    options: CommandDeliveryOptions = {},
  ) {
    this.maxBatchSize = options.maxBatchSize ?? 10;

    if (!Number.isInteger(this.maxBatchSize) || this.maxBatchSize < 1 || this.maxBatchSize > 100) {
      throw new Error("Command delivery batch size must be between 1 and 100.");
    }
  }

  async drainOnce(): Promise<CommandDrainResult> {
    if (this.session.isExpired()) {
      throw new Error("Cannot fetch commands with an expired control session.");
    }

    const { credential } = this.session;
    const batch = await this.transport.fetchCommands(
      credential.accessToken,
      credential.sessionId,
      this.maxBatchSize,
    );

    this.validateBatch(batch, credential.sessionId);

    const acknowledgements: CommandAcknowledgement[] = [];

    for (const command of batch.commands) {
      const acknowledgement = await this.processor.process(command, credential);

      await this.transport.acknowledgeCommand(
        credential.accessToken,
        acknowledgement,
      );

      acknowledgements.push(acknowledgement);
    }

    return {
      batchId: batch.batchId,
      acknowledgements,
    };
  }

  private validateBatch(batch: CommandBatch, expectedSessionId: string): void {
    if (batch.version !== "kab.command-batch.v1") {
      throw new Error("Unsupported command batch version.");
    }

    if (!batch.batchId) {
      throw new Error("Command batch ID is missing.");
    }

    if (batch.sessionId !== expectedSessionId) {
      throw new Error("Command batch targets a different control session.");
    }

    if (!Array.isArray(batch.commands) || batch.commands.length > this.maxBatchSize) {
      throw new Error("Command batch size is invalid.");
    }
  }
}

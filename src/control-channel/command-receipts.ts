import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type CommandOutcomeStatus =
  | "executed"
  | "approval_required"
  | "denied"
  | "failed"
  | "expired"
  | "rejected";

export type CommandProcessingReceipt = {
  version: "kab.command-receipt.v1";
  commandId: string;
  actionFingerprint: string;
  state: "processing";
  startedAt: string;
  retainUntil: string;
};

export type CommandCompletedReceipt = {
  version: "kab.command-receipt.v1";
  commandId: string;
  actionFingerprint: string;
  state: "completed";
  startedAt: string;
  completedAt: string;
  retainUntil: string;
  outcome: CommandOutcomeStatus;
};

export type CommandReceipt = CommandProcessingReceipt | CommandCompletedReceipt;

export type CommandReceiptClaimResult =
  | { claimed: true; receipt: CommandProcessingReceipt }
  | { claimed: false; receipt: CommandReceipt };

/**
 * Receipt-store contract used to prevent command re-execution.
 *
 * `claim()` MUST be atomic across every runtime instance that shares the store:
 * exactly one caller may create the first processing receipt for a commandId.
 * A Redis/Mongo/SQL implementation should use SET NX, a unique insert, or an
 * equivalent conditional write rather than get-then-set.
 *
 * `complete()` MUST behave as a compare-and-set transition from the matching
 * processing fingerprint to completed. It must never overwrite a receipt for
 * a different fingerprint.
 */
export interface CommandReceiptStore {
  get(commandId: string): Promise<CommandReceipt | null>;
  claim(receipt: CommandProcessingReceipt): Promise<CommandReceiptClaimResult>;
  complete(receipt: CommandCompletedReceipt): Promise<void>;
  prune(now: Date): Promise<number>;
  /**
   * Low-level maintenance/test helper retained for compatibility. CommandProcessor
   * deliberately never uses save() for execution claims.
   */
  save(receipt: CommandReceipt): Promise<void>;
}

export class InMemoryCommandReceiptStore implements CommandReceiptStore {
  private readonly receipts = new Map<string, CommandReceipt>();

  async get(commandId: string): Promise<CommandReceipt | null> {
    const receipt = this.receipts.get(commandId);
    return receipt ? structuredClone(receipt) : null;
  }

  async claim(receipt: CommandProcessingReceipt): Promise<CommandReceiptClaimResult> {
    const existing = this.receipts.get(receipt.commandId);
    if (existing) {
      return { claimed: false, receipt: structuredClone(existing) };
    }
    this.receipts.set(receipt.commandId, structuredClone(receipt));
    return { claimed: true, receipt: structuredClone(receipt) };
  }

  async complete(receipt: CommandCompletedReceipt): Promise<void> {
    const existing = this.receipts.get(receipt.commandId);
    validateCompletionTransition(existing, receipt);
    this.receipts.set(receipt.commandId, structuredClone(receipt));
  }

  async save(receipt: CommandReceipt): Promise<void> {
    this.receipts.set(receipt.commandId, structuredClone(receipt));
  }

  async prune(now: Date): Promise<number> {
    let removed = 0;

    for (const [commandId, receipt] of this.receipts.entries()) {
      if (Date.parse(receipt.retainUntil) <= now.getTime()) {
        this.receipts.delete(commandId);
        removed += 1;
      }
    }

    return removed;
  }
}

interface ReceiptFileV1 {
  version: "kab.command-receipt-store.v1";
  receipts: CommandReceipt[];
}

/**
 * Single-host/file baseline. Operations are serialized inside this process.
 * Do not share the same file between independent processes/hosts; clustered
 * deployments must provide a CommandReceiptStore with backend-level atomicity.
 */
export class FileCommandReceiptStore implements CommandReceiptStore {
  private operation: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async get(commandId: string): Promise<CommandReceipt | null> {
    return this.withLock(async () => {
      const file = await this.loadFile();
      const receipt = file.receipts.find((item) => item.commandId === commandId);
      return receipt ? structuredClone(receipt) : null;
    });
  }

  async claim(receipt: CommandProcessingReceipt): Promise<CommandReceiptClaimResult> {
    return this.withLock(async () => {
      const file = await this.loadFile();
      const existing = file.receipts.find(
        (item) => item.commandId === receipt.commandId,
      );
      if (existing) {
        return { claimed: false, receipt: structuredClone(existing) };
      }
      file.receipts.push(structuredClone(receipt));
      await this.writeFile(file);
      return { claimed: true, receipt: structuredClone(receipt) };
    });
  }

  async complete(receipt: CommandCompletedReceipt): Promise<void> {
    await this.withLock(async () => {
      const file = await this.loadFile();
      const index = file.receipts.findIndex(
        (item) => item.commandId === receipt.commandId,
      );
      const existing = index >= 0 ? file.receipts[index] : undefined;
      validateCompletionTransition(existing, receipt);
      file.receipts[index] = structuredClone(receipt);
      await this.writeFile(file);
    });
  }

  async save(receipt: CommandReceipt): Promise<void> {
    await this.withLock(async () => {
      const file = await this.loadFile();
      const index = file.receipts.findIndex(
        (item) => item.commandId === receipt.commandId,
      );

      if (index >= 0) {
        file.receipts[index] = structuredClone(receipt);
      } else {
        file.receipts.push(structuredClone(receipt));
      }

      await this.writeFile(file);
    });
  }

  async prune(now: Date): Promise<number> {
    return this.withLock(async () => {
      const file = await this.loadFile();
      const before = file.receipts.length;
      file.receipts = file.receipts.filter(
        (receipt) => Date.parse(receipt.retainUntil) > now.getTime(),
      );

      const removed = before - file.receipts.length;
      if (removed > 0) await this.writeFile(file);
      return removed;
    });
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    let release: (() => void) | undefined;
    const previous = this.operation;
    this.operation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release?.();
    }
  }

  private async loadFile(): Promise<ReceiptFileV1> {
    try {
      const content = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(content) as ReceiptFileV1;

      if (parsed.version !== "kab.command-receipt-store.v1") {
        throw new Error("Unsupported command receipt store version.");
      }

      if (!Array.isArray(parsed.receipts)) {
        throw new Error("Command receipt store is malformed.");
      }

      return parsed;
    } catch (error) {
      if (isFileNotFound(error)) {
        return {
          version: "kab.command-receipt-store.v1",
          receipts: [],
        };
      }

      throw error;
    }
  }

  private async writeFile(file: ReceiptFileV1): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });

    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    const content = `${JSON.stringify(file, null, 2)}\n`;

    try {
      await writeFile(temporaryPath, content, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

function validateCompletionTransition(
  existing: CommandReceipt | undefined,
  receipt: CommandCompletedReceipt,
): void {
  if (!existing) {
    throw new Error("Cannot complete a command receipt that was not atomically claimed.");
  }
  if (existing.actionFingerprint !== receipt.actionFingerprint) {
    throw new Error("Cannot complete a command receipt with a different action fingerprint.");
  }
  if (existing.state === "completed") {
    if (existing.outcome !== receipt.outcome) {
      throw new Error("Cannot replace a completed command receipt with a different outcome.");
    }
    return;
  }
  if (existing.startedAt !== receipt.startedAt) {
    throw new Error("Cannot complete a command receipt from a different processing claim.");
  }
}

function isFileNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

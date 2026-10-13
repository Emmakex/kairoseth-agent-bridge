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

export type CommandReceipt =
  | {
      version: "kab.command-receipt.v1";
      commandId: string;
      actionFingerprint: string;
      state: "processing";
      startedAt: string;
      retainUntil: string;
    }
  | {
      version: "kab.command-receipt.v1";
      commandId: string;
      actionFingerprint: string;
      state: "completed";
      startedAt: string;
      completedAt: string;
      retainUntil: string;
      outcome: CommandOutcomeStatus;
    };

export interface CommandReceiptStore {
  get(commandId: string): Promise<CommandReceipt | null>;
  save(receipt: CommandReceipt): Promise<void>;
  prune(now: Date): Promise<number>;
}

export class InMemoryCommandReceiptStore implements CommandReceiptStore {
  private readonly receipts = new Map<string, CommandReceipt>();

  async get(commandId: string): Promise<CommandReceipt | null> {
    const receipt = this.receipts.get(commandId);
    return receipt ? structuredClone(receipt) : null;
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

export class FileCommandReceiptStore implements CommandReceiptStore {
  constructor(private readonly filePath: string) {}

  async get(commandId: string): Promise<CommandReceipt | null> {
    const file = await this.loadFile();
    const receipt = file.receipts.find((item) => item.commandId === commandId);
    return receipt ? structuredClone(receipt) : null;
  }

  async save(receipt: CommandReceipt): Promise<void> {
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
  }

  async prune(now: Date): Promise<number> {
    const file = await this.loadFile();
    const before = file.receipts.length;
    file.receipts = file.receipts.filter(
      (receipt) => Date.parse(receipt.retainUntil) > now.getTime(),
    );

    const removed = before - file.receipts.length;

    if (removed > 0) {
      await this.writeFile(file);
    }

    return removed;
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

function isFileNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

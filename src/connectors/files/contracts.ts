import type { ToolLocalizations } from "../../core/contracts.js";

export type FileRootAccess = "read" | "write" | "full";

export interface FileRootDefinition {
  id: string;
  path: string;
  name: string;
  description: string;
  /** Every official/deployment root must provide both ES and EN metadata. */
  localizations: ToolLocalizations;
  /** read = list/read; write = list/read/write; full = plus delete/move CRITICAL tools. */
  access: FileRootAccess;
  maxReadBytes?: number | undefined;
  maxWriteBytes?: number | undefined;
  /** Optional lowercase/uppercase-insensitive extensions such as .txt, .json. */
  allowedExtensions?: readonly string[] | undefined;
  /** Dot-prefixed path segments are blocked by default. */
  allowDotFiles?: boolean | undefined;
}

export interface FilesConnectorOptions {
  roots: readonly FileRootDefinition[];
}

export type FileContentEncoding = "utf8" | "base64";

export interface ValidatedFileRoot {
  definition: FileRootDefinition;
  rootPath: string;
  maxReadBytes: number;
  maxWriteBytes: number;
  allowedExtensions?: ReadonlySet<string> | undefined;
  allowDotFiles: boolean;
}

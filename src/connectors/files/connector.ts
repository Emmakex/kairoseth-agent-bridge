import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  open,
  readdir,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import type { ToolLocalizations } from "../../core/contracts.js";
import {
  ConnectorConfigurationError,
  ConnectorError,
  ConnectorTransientError,
} from "../sdk/errors.js";
import type {
  ConnectorDefinition,
  ConnectorHealthResult,
  ConnectorToolDefinition,
  JsonSchema,
} from "../sdk/contracts.js";
import type {
  FileContentEncoding,
  FileRootDefinition,
  FilesConnectorOptions,
  ValidatedFileRoot,
} from "./contracts.js";

const DEFAULT_MAX_READ_BYTES = 1_048_576;
const DEFAULT_MAX_WRITE_BYTES = 1_048_576;
const ABSOLUTE_MAX_BYTES = 10 * 1_048_576;
const MAX_LIST_ENTRIES = 500;
const MAX_RELATIVE_PATH_LENGTH = 1024;
const ROOT_ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const TRANSIENT_FS_CODES = new Set(["EAGAIN", "EBUSY", "EMFILE", "ENFILE"]);
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

export function createFilesConnector(
  options: FilesConnectorOptions,
): ConnectorDefinition {
  const roots = validateRoots(options.roots);
  const tools = roots.flatMap((root) => rootTools(root));

  return {
    manifest: {
      id: "files",
      name: "Files",
      version: "1.0.0",
      description:
        "Kairoseth root-scoped filesystem connector with traversal and symlink protections.",
      localizations: {
        en: {
          name: "Files",
          description:
            "Kairoseth root-scoped filesystem connector with traversal and symlink protections.",
        },
        es: {
          name: "Archivos",
          description:
            "Conector Kairoseth de archivos limitado a roots declarados, con protección frente a traversal y symlinks.",
        },
      },
      capabilities: fileCapabilities(roots),
      configSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      credentials: [],
    },
    tools,
    health: async (): Promise<ConnectorHealthResult> => {
      const checkedAt = new Date().toISOString();
      try {
        for (const root of roots) {
          await canonicalRoot(root);
        }
        return {
          status: "healthy",
          checkedAt,
          message: "All declared filesystem roots are accessible directories.",
          details: { rootCount: roots.length },
        };
      } catch (error) {
        return {
          status: "unhealthy",
          checkedAt,
          message: `Filesystem root health check failed${safeFsCodeSuffix(error)}.`,
        };
      }
    },
  };
}

function rootTools(root: ValidatedFileRoot): readonly ConnectorToolDefinition[] {
  const tools: ConnectorToolDefinition[] = [
    {
      id: `${root.definition.id}.list`,
      name: `List files in ${root.definition.name}`,
      description: `List one directory inside the declared ${root.definition.name} root.`,
      localizations: localizedTool(root, "list"),
      risk: "READ",
      inputSchema: listInputSchema(),
      outputSchema: {
        type: "object",
        properties: {
          entries: {
            type: "array",
            items: { type: "object", additionalProperties: true },
          },
          total: { type: "integer", minimum: 0 },
        },
        required: ["entries", "total"],
        additionalProperties: false,
      },
      behavior: readBehavior(),
      execute: async (input) =>
        await withFsErrors("READ", `${root.definition.id}.list`, async () => {
          const normalized = normalizeListInput(root, input);
          const directory = await resolveExistingDirectory(root, normalized.segments);
          const raw = await readdir(directory.absolutePath, { withFileTypes: true });
          const entries = raw
            .filter((entry) => visibleDirectoryEntry(root, entry.name, entry.isFile()))
            .map((entry) => ({
              name: entry.name,
              path: joinRelative(normalized.relativePath, entry.name),
              type: directoryEntryType(entry),
            }))
            .sort((a, b) => a.name.localeCompare(b.name, "en"));

          return {
            entries: entries.slice(
              normalized.offset,
              normalized.offset + normalized.limit,
            ),
            total: entries.length,
          };
        }),
    },
    {
      id: `${root.definition.id}.read`,
      name: `Read file from ${root.definition.name}`,
      description: `Read one bounded regular file inside the declared ${root.definition.name} root.`,
      localizations: localizedTool(root, "read"),
      risk: "READ",
      inputSchema: readInputSchema(),
      outputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          size: { type: "integer", minimum: 0 },
          encoding: { type: "string", enum: ["utf8", "base64"] },
          content: { type: "string" },
          sha256: { type: "string" },
        },
        required: ["path", "size", "encoding", "content", "sha256"],
        additionalProperties: false,
      },
      behavior: readBehavior(),
      execute: async (input) =>
        await withFsErrors("READ", `${root.definition.id}.read`, async () => {
          const normalized = normalizeReadInput(root, input);
          const resolved = await resolveExistingFile(root, normalized.segments);
          const handle = await open(
            resolved.absolutePath,
            constants.O_RDONLY | O_NOFOLLOW,
          );
          try {
            const stat = await handle.stat();
            if (!stat.isFile()) {
              throw new ConnectorError("Files read target must be a regular file.");
            }
            if (stat.size > root.maxReadBytes) {
              throw new ConnectorError(
                `Files read target exceeds ${root.maxReadBytes} bytes.`,
              );
            }
            const bytes = await handle.readFile();
            if (bytes.byteLength > root.maxReadBytes) {
              throw new ConnectorError(
                `Files read target exceeds ${root.maxReadBytes} bytes.`,
              );
            }
            return {
              path: normalized.relativePath,
              size: bytes.byteLength,
              encoding: normalized.encoding,
              content:
                normalized.encoding === "base64"
                  ? bytes.toString("base64")
                  : bytes.toString("utf8"),
              sha256: sha256(bytes),
            };
          } finally {
            await handle.close().catch(() => undefined);
          }
        }),
    },
  ];

  if (root.definition.access === "write" || root.definition.access === "full") {
    tools.push({
      id: `${root.definition.id}.write`,
      name: `Write file in ${root.definition.name}`,
      description: `Create or explicitly overwrite one bounded regular file inside the declared ${root.definition.name} root.`,
      localizations: localizedTool(root, "write"),
      risk: "WRITE",
      inputSchema: writeInputSchema(),
      outputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          size: { type: "integer", minimum: 0 },
          created: { type: "boolean" },
          sha256: { type: "string" },
        },
        required: ["path", "size", "created", "sha256"],
        additionalProperties: false,
      },
      behavior: {
        retry: { mode: "never" },
        idempotency: { mode: "none" },
      },
      execute: async (input) =>
        await withFsErrors("WRITE", `${root.definition.id}.write`, async () => {
          const normalized = normalizeWriteInput(root, input);
          const bytes = decodeWriteContent(normalized.content, normalized.encoding);
          if (bytes.byteLength > root.maxWriteBytes) {
            throw new ConnectorError(
              `Files write content exceeds ${root.maxWriteBytes} bytes.`,
            );
          }

          const target = await resolveTargetParent(root, normalized.segments);
          const existing = await tryLstat(target.absolutePath);
          if (existing?.isSymbolicLink()) {
            throw new ConnectorError("Files write target cannot be a symbolic link.");
          }
          if (existing && !existing.isFile()) {
            throw new ConnectorError("Files write target must be a regular file.");
          }
          if (existing && !normalized.overwrite) {
            throw new ConnectorError(
              "Files write target already exists; overwrite must be explicit.",
            );
          }

          const flags =
            constants.O_WRONLY |
            constants.O_CREAT |
            O_NOFOLLOW |
            (normalized.overwrite ? constants.O_TRUNC : constants.O_EXCL);
          const handle = await open(target.absolutePath, flags, 0o600);
          try {
            const stat = await handle.stat();
            if (!stat.isFile()) {
              throw new ConnectorError("Files write target must be a regular file.");
            }
            await handle.writeFile(bytes);
            await handle.sync();
          } finally {
            await handle.close().catch(() => undefined);
          }

          return {
            path: normalized.relativePath,
            size: bytes.byteLength,
            created: existing === undefined,
            sha256: sha256(bytes),
          };
        }),
    });
  }

  if (root.definition.access === "full") {
    tools.push(
      {
        id: `${root.definition.id}.delete`,
        name: `Delete file from ${root.definition.name}`,
        description: `Delete one regular file inside the declared ${root.definition.name} root. Directories and symlinks are not deleted.`,
        localizations: localizedTool(root, "delete"),
        risk: "CRITICAL",
        inputSchema: singlePathInputSchema(),
        outputSchema: {
          type: "object",
          properties: { path: { type: "string" }, deleted: { type: "boolean" } },
          required: ["path", "deleted"],
          additionalProperties: false,
        },
        behavior: {
          retry: { mode: "never" },
          idempotency: { mode: "none" },
        },
        execute: async (input) =>
          await withFsErrors("CRITICAL", `${root.definition.id}.delete`, async () => {
            const normalized = normalizeSinglePathInput(root, input, "delete");
            const resolved = await resolveExistingFile(root, normalized.segments);
            await unlink(resolved.absolutePath);
            return { path: normalized.relativePath, deleted: true };
          }),
      },
      {
        id: `${root.definition.id}.move`,
        name: `Move file in ${root.definition.name}`,
        description: `Move one regular file to another path inside the same declared ${root.definition.name} root.`,
        localizations: localizedTool(root, "move"),
        risk: "CRITICAL",
        inputSchema: moveInputSchema(),
        outputSchema: {
          type: "object",
          properties: {
            sourcePath: { type: "string" },
            destinationPath: { type: "string" },
            moved: { type: "boolean" },
          },
          required: ["sourcePath", "destinationPath", "moved"],
          additionalProperties: false,
        },
        behavior: {
          retry: { mode: "never" },
          idempotency: { mode: "none" },
        },
        execute: async (input) =>
          await withFsErrors("CRITICAL", `${root.definition.id}.move`, async () => {
            const normalized = normalizeMoveInput(root, input);
            const source = await resolveExistingFile(root, normalized.sourceSegments);
            const destination = await resolveTargetParent(
              root,
              normalized.destinationSegments,
            );
            if (source.absolutePath === destination.absolutePath) {
              throw new ConnectorError(
                "Files move source and destination must be different.",
              );
            }

            const existing = await tryLstat(destination.absolutePath);
            if (existing?.isSymbolicLink()) {
              throw new ConnectorError(
                "Files move destination cannot be a symbolic link.",
              );
            }
            if (existing && !existing.isFile()) {
              throw new ConnectorError(
                "Files move destination must be a regular file when it exists.",
              );
            }
            if (existing && !normalized.overwrite) {
              throw new ConnectorError(
                "Files move destination already exists; overwrite must be explicit.",
              );
            }

            await rename(source.absolutePath, destination.absolutePath);
            return {
              sourcePath: normalized.sourcePath,
              destinationPath: normalized.destinationPath,
              moved: true,
            };
          }),
      },
    );
  }

  return tools;
}

function validateRoots(
  roots: readonly FileRootDefinition[],
): readonly ValidatedFileRoot[] {
  if (!Array.isArray(roots) || roots.length === 0) {
    throw new ConnectorConfigurationError(
      "Files connector requires at least one declared root.",
    );
  }
  if (roots.length > 50) {
    throw new ConnectorConfigurationError(
      "Files connector supports at most 50 declared roots.",
    );
  }

  const ids = new Set<string>();
  const rootPaths = new Set<string>();
  return roots.map((definition) => {
    if (!ROOT_ID_PATTERN.test(definition.id)) {
      throw new ConnectorConfigurationError(
        `Files root id is invalid: ${definition.id}`,
      );
    }
    if (ids.has(definition.id)) {
      throw new ConnectorConfigurationError(
        `Duplicate Files root id: ${definition.id}`,
      );
    }
    ids.add(definition.id);

    if (typeof definition.path !== "string" || !path.isAbsolute(definition.path)) {
      throw new ConnectorConfigurationError(
        `Files root ${definition.id} path must be absolute.`,
      );
    }
    if (definition.path.includes("\0")) {
      throw new ConnectorConfigurationError(
        `Files root ${definition.id} path is invalid.`,
      );
    }
    const rootPath = path.resolve(definition.path);
    const rootKey = process.platform === "win32" ? rootPath.toLowerCase() : rootPath;
    if (rootPaths.has(rootKey)) {
      throw new ConnectorConfigurationError(
        `Files root ${definition.id} duplicates another declared root path.`,
      );
    }
    rootPaths.add(rootKey);

    if (
      definition.access !== "read" &&
      definition.access !== "write" &&
      definition.access !== "full"
    ) {
      throw new ConnectorConfigurationError(
        `Files root ${definition.id} access is invalid.`,
      );
    }
    requireLocalizedRootText(definition);

    return {
      definition,
      rootPath,
      maxReadBytes: normalizeByteLimit(
        definition.maxReadBytes,
        DEFAULT_MAX_READ_BYTES,
        `${definition.id} maxReadBytes`,
      ),
      maxWriteBytes: normalizeByteLimit(
        definition.maxWriteBytes,
        DEFAULT_MAX_WRITE_BYTES,
        `${definition.id} maxWriteBytes`,
      ),
      allowedExtensions: normalizeExtensions(definition.allowedExtensions),
      allowDotFiles: definition.allowDotFiles === true,
    };
  });
}

function normalizeByteLimit(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const normalized = value ?? fallback;
  if (
    !Number.isInteger(normalized) ||
    normalized < 1 ||
    normalized > ABSOLUTE_MAX_BYTES
  ) {
    throw new ConnectorConfigurationError(
      `Files ${label} must be between 1 and ${ABSOLUTE_MAX_BYTES}.`,
    );
  }
  return normalized;
}

function normalizeExtensions(
  values: readonly string[] | undefined,
): ReadonlySet<string> | undefined {
  if (values === undefined) return undefined;
  if (values.length === 0) {
    throw new ConnectorConfigurationError(
      "Files allowedExtensions cannot be empty when declared.",
    );
  }
  const result = new Set<string>();
  for (const value of values) {
    const normalized = value.trim().toLowerCase();
    if (!/^\.[a-z0-9][a-z0-9._-]{0,31}$/.test(normalized)) {
      throw new ConnectorConfigurationError(
        `Files allowed extension is invalid: ${value}`,
      );
    }
    result.add(normalized);
  }
  return result;
}

function requireLocalizedRootText(definition: FileRootDefinition): void {
  if (!definition.name.trim() || !definition.description.trim()) {
    throw new ConnectorConfigurationError(
      `Files root ${definition.id} requires canonical name and description.`,
    );
  }
  for (const locale of ["es", "en"] as const) {
    const localized = definition.localizations[locale];
    if (!localized?.name.trim() || !localized.description.trim()) {
      throw new ConnectorConfigurationError(
        `Files root ${definition.id} requires ${locale.toUpperCase()} name and description.`,
      );
    }
  }
}

function localizedTool(
  root: ValidatedFileRoot,
  operation: "list" | "read" | "write" | "delete" | "move",
): ToolLocalizations {
  const enRoot = root.definition.localizations.en!;
  const esRoot = root.definition.localizations.es!;
  const enNames = {
    list: `List ${enRoot.name}`,
    read: `Read file from ${enRoot.name}`,
    write: `Write file in ${enRoot.name}`,
    delete: `Delete file from ${enRoot.name}`,
    move: `Move file in ${enRoot.name}`,
  } as const;
  const esNames = {
    list: `Listar ${esRoot.name}`,
    read: `Leer archivo de ${esRoot.name}`,
    write: `Escribir archivo en ${esRoot.name}`,
    delete: `Eliminar archivo de ${esRoot.name}`,
    move: `Mover archivo en ${esRoot.name}`,
  } as const;
  const enDescriptions = {
    list: `List one directory inside ${enRoot.name}.`,
    read: `Read one bounded regular file inside ${enRoot.name}.`,
    write: `Create or explicitly overwrite one bounded regular file inside ${enRoot.name}.`,
    delete: `Delete one regular file inside ${enRoot.name}; directories and symlinks are excluded.`,
    move: `Move one regular file to another path inside the same ${enRoot.name} root.`,
  } as const;
  const esDescriptions = {
    list: `Lista un directorio dentro de ${esRoot.name}.`,
    read: `Lee un archivo regular y acotado dentro de ${esRoot.name}.`,
    write: `Crea o sobrescribe explícitamente un archivo regular y acotado dentro de ${esRoot.name}.`,
    delete: `Elimina un archivo regular dentro de ${esRoot.name}; no elimina directorios ni symlinks.`,
    move: `Mueve un archivo regular a otra ruta dentro del mismo root ${esRoot.name}.`,
  } as const;
  return {
    en: { name: enNames[operation], description: enDescriptions[operation] },
    es: { name: esNames[operation], description: esDescriptions[operation] },
  };
}

function readBehavior() {
  return {
    retry: {
      mode: "transient" as const,
      maxAttempts: 3,
      baseDelayMs: 100,
      maxDelayMs: 500,
    },
  };
}

async function withFsErrors<T>(
  risk: "READ" | "WRITE" | "CRITICAL",
  label: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ConnectorError) throw error;
    const suffix = safeFsCodeSuffix(error);
    if (risk === "READ" && TRANSIENT_FS_CODES.has(fsErrorCode(error) ?? "")) {
      throw new ConnectorTransientError(
        `Files READ operation ${label} failed transiently${suffix}.`,
        { cause: error },
      );
    }
    throw new ConnectorError(`Files operation ${label} failed${suffix}.`, {
      cause: error,
    });
  }
}

async function canonicalRoot(root: ValidatedFileRoot): Promise<string> {
  const resolved = await realpath(root.rootPath);
  const stat = await lstat(resolved);
  if (!stat.isDirectory()) {
    throw new ConnectorError(
      `Files root ${root.definition.id} is not a directory.`,
    );
  }
  return resolved;
}

async function resolveExistingDirectory(
  root: ValidatedFileRoot,
  segments: readonly string[],
): Promise<{ absolutePath: string }> {
  const rootReal = await canonicalRoot(root);
  let current = rootReal;
  for (const segment of segments) {
    current = path.join(current, segment);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) {
      throw new ConnectorError(
        "Files paths cannot traverse symbolic links.",
      );
    }
    if (!stat.isDirectory()) {
      throw new ConnectorError("Files list target must be a directory.");
    }
  }
  return { absolutePath: current };
}

async function resolveExistingFile(
  root: ValidatedFileRoot,
  segments: readonly string[],
): Promise<{ absolutePath: string }> {
  if (segments.length === 0) {
    throw new ConnectorError("Files file path cannot target the root directory.");
  }
  const rootReal = await canonicalRoot(root);
  let current = rootReal;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]!);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) {
      throw new ConnectorError(
        "Files paths cannot traverse symbolic links.",
      );
    }
    if (index < segments.length - 1 && !stat.isDirectory()) {
      throw new ConnectorError(
        "Files path contains a non-directory parent segment.",
      );
    }
    if (index === segments.length - 1 && !stat.isFile()) {
      throw new ConnectorError("Files target must be a regular file.");
    }
  }
  return { absolutePath: current };
}

async function resolveTargetParent(
  root: ValidatedFileRoot,
  segments: readonly string[],
): Promise<{ absolutePath: string }> {
  if (segments.length === 0) {
    throw new ConnectorError("Files target path cannot be empty.");
  }
  const rootReal = await canonicalRoot(root);
  let parent = rootReal;
  for (const segment of segments.slice(0, -1)) {
    parent = path.join(parent, segment);
    const stat = await lstat(parent);
    if (stat.isSymbolicLink()) {
      throw new ConnectorError(
        "Files paths cannot traverse symbolic links.",
      );
    }
    if (!stat.isDirectory()) {
      throw new ConnectorError(
        "Files target contains a non-directory parent segment.",
      );
    }
  }
  return { absolutePath: path.join(parent, segments.at(-1)!) };
}

function normalizeListInput(
  root: ValidatedFileRoot,
  input: unknown,
): {
  relativePath: string;
  segments: readonly string[];
  offset: number;
  limit: number;
} {
  const record = exactInput(input, ["path", "offset", "limit"], "list");
  const relativePath = record.path === undefined ? "" : requireString(record.path, "path");
  const segments = normalizeRelativePath(root, relativePath, true, false);
  const offset = optionalInteger(record.offset, "offset", 0, Number.MAX_SAFE_INTEGER) ?? 0;
  const limit = optionalInteger(record.limit, "limit", 1, MAX_LIST_ENTRIES) ?? 100;
  return { relativePath: segments.join("/"), segments, offset, limit };
}

function normalizeReadInput(
  root: ValidatedFileRoot,
  input: unknown,
): {
  relativePath: string;
  segments: readonly string[];
  encoding: FileContentEncoding;
} {
  const record = exactInput(input, ["path", "encoding"], "read");
  const relativePath = requireString(record.path, "path");
  const segments = normalizeRelativePath(root, relativePath, false, true);
  return {
    relativePath: segments.join("/"),
    segments,
    encoding: normalizeEncoding(record.encoding),
  };
}

function normalizeWriteInput(
  root: ValidatedFileRoot,
  input: unknown,
): {
  relativePath: string;
  segments: readonly string[];
  encoding: FileContentEncoding;
  content: string;
  overwrite: boolean;
} {
  const record = exactInput(
    input,
    ["path", "content", "encoding", "overwrite"],
    "write",
  );
  const relativePath = requireString(record.path, "path");
  const segments = normalizeRelativePath(root, relativePath, false, true);
  const content = requireString(record.content, "content");
  if (record.overwrite !== undefined && typeof record.overwrite !== "boolean") {
    throw new ConnectorError("Files overwrite must be boolean.");
  }
  return {
    relativePath: segments.join("/"),
    segments,
    content,
    encoding: normalizeEncoding(record.encoding),
    overwrite: record.overwrite === true,
  };
}

function normalizeSinglePathInput(
  root: ValidatedFileRoot,
  input: unknown,
  label: string,
): { relativePath: string; segments: readonly string[] } {
  const record = exactInput(input, ["path"], label);
  const relativePath = requireString(record.path, "path");
  const segments = normalizeRelativePath(root, relativePath, false, true);
  return { relativePath: segments.join("/"), segments };
}

function normalizeMoveInput(
  root: ValidatedFileRoot,
  input: unknown,
): {
  sourcePath: string;
  destinationPath: string;
  sourceSegments: readonly string[];
  destinationSegments: readonly string[];
  overwrite: boolean;
} {
  const record = exactInput(
    input,
    ["sourcePath", "destinationPath", "overwrite"],
    "move",
  );
  const sourceSegments = normalizeRelativePath(
    root,
    requireString(record.sourcePath, "sourcePath"),
    false,
    true,
  );
  const destinationSegments = normalizeRelativePath(
    root,
    requireString(record.destinationPath, "destinationPath"),
    false,
    true,
  );
  if (record.overwrite !== undefined && typeof record.overwrite !== "boolean") {
    throw new ConnectorError("Files overwrite must be boolean.");
  }
  return {
    sourcePath: sourceSegments.join("/"),
    destinationPath: destinationSegments.join("/"),
    sourceSegments,
    destinationSegments,
    overwrite: record.overwrite === true,
  };
}

function normalizeRelativePath(
  root: ValidatedFileRoot,
  value: string,
  allowRoot: boolean,
  fileTarget: boolean,
): readonly string[] {
  if (value.length > MAX_RELATIVE_PATH_LENGTH) {
    throw new ConnectorError(
      `Files relative path exceeds ${MAX_RELATIVE_PATH_LENGTH} characters.`,
    );
  }
  if (value === "") {
    if (allowRoot) return [];
    throw new ConnectorError("Files relative path cannot be empty.");
  }
  if (
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes(":") ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new ConnectorError(
      "Files paths must use portable relative '/' syntax without reserved characters.",
    );
  }
  const segments = value.split("/");
  for (const segment of segments) {
    if (!segment || segment === "." || segment === "..") {
      throw new ConnectorError("Files relative path contains an unsafe segment.");
    }
    if (!root.allowDotFiles && segment.startsWith(".")) {
      throw new ConnectorError("Files dot-prefixed paths are blocked for this root.");
    }
  }
  if (fileTarget) assertAllowedExtension(root, segments.at(-1)!);
  return segments;
}

function assertAllowedExtension(root: ValidatedFileRoot, fileName: string): void {
  if (!root.allowedExtensions) return;
  const normalized = fileName.toLowerCase();
  if (![...root.allowedExtensions].some((extension) => normalized.endsWith(extension))) {
    throw new ConnectorError("Files target extension is not allowlisted for this root.");
  }
}

function visibleDirectoryEntry(
  root: ValidatedFileRoot,
  name: string,
  isFile: boolean,
): boolean {
  if (!root.allowDotFiles && name.startsWith(".")) return false;
  if (isFile && root.allowedExtensions) {
    const normalized = name.toLowerCase();
    return [...root.allowedExtensions].some((extension) =>
      normalized.endsWith(extension),
    );
  }
  return true;
}

function directoryEntryType(entry: {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}): "file" | "directory" | "symlink" | "other" {
  if (entry.isFile()) return "file";
  if (entry.isDirectory()) return "directory";
  if (entry.isSymbolicLink()) return "symlink";
  return "other";
}

function exactInput(
  input: unknown,
  allowedKeys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ConnectorError(`Files ${label} input must be an object.`);
  }
  const record = input as Record<string, unknown>;
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(record).find((key) => !allowed.has(key));
  if (unknown) {
    throw new ConnectorError(`Files ${label} contains unsupported field: ${unknown}.`);
  }
  return record;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new ConnectorError(`Files ${field} must be a string.`);
  }
  return value;
}

function optionalInteger(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new ConnectorError(
      `Files ${field} must be an integer between ${min} and ${max}.`,
    );
  }
  return value;
}

function normalizeEncoding(value: unknown): FileContentEncoding {
  if (value === undefined || value === "utf8") return "utf8";
  if (value === "base64") return "base64";
  throw new ConnectorError("Files encoding must be utf8 or base64.");
}

function decodeWriteContent(content: string, encoding: FileContentEncoding): Buffer {
  if (encoding === "utf8") return Buffer.from(content, "utf8");
  if (!isStrictBase64(content)) {
    throw new ConnectorError("Files base64 content is invalid.");
  }
  return Buffer.from(content, "base64");
}

function isStrictBase64(value: string): boolean {
  if (value.length === 0) return true;
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false;
  const paddingIndex = value.indexOf("=");
  return paddingIndex === -1 || paddingIndex >= value.length - 2;
}

async function tryLstat(target: string) {
  try {
    return await lstat(target);
  } catch (error) {
    if (fsErrorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function joinRelative(parent: string, child: string): string {
  return parent ? `${parent}/${child}` : child;
}

function fileCapabilities(roots: readonly ValidatedFileRoot[]): readonly string[] {
  const capabilities = new Set<string>(["files.read"]);
  if (roots.some((root) => root.definition.access === "write" || root.definition.access === "full")) {
    capabilities.add("files.write");
  }
  if (roots.some((root) => root.definition.access === "full")) {
    capabilities.add("files.critical");
  }
  return [...capabilities].sort();
}

function fsErrorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const code = (error as Record<string, unknown>).code;
  return typeof code === "string" && /^[A-Z0-9_]{2,32}$/.test(code)
    ? code
    : undefined;
}

function safeFsCodeSuffix(error: unknown): string {
  const code = fsErrorCode(error);
  return code ? ` (${code})` : "";
}

function listInputSchema(): JsonSchema {
  return {
    type: "object",
    properties: {
      path: { type: "string", maxLength: MAX_RELATIVE_PATH_LENGTH },
      offset: { type: "integer", minimum: 0 },
      limit: { type: "integer", minimum: 1, maximum: MAX_LIST_ENTRIES },
    },
    additionalProperties: false,
  };
}

function readInputSchema(): JsonSchema {
  return {
    type: "object",
    properties: {
      path: { type: "string", minLength: 1, maxLength: MAX_RELATIVE_PATH_LENGTH },
      encoding: { type: "string", enum: ["utf8", "base64"], default: "utf8" },
    },
    required: ["path"],
    additionalProperties: false,
  };
}

function writeInputSchema(): JsonSchema {
  return {
    type: "object",
    properties: {
      path: { type: "string", minLength: 1, maxLength: MAX_RELATIVE_PATH_LENGTH },
      content: { type: "string" },
      encoding: { type: "string", enum: ["utf8", "base64"], default: "utf8" },
      overwrite: { type: "boolean", default: false },
    },
    required: ["path", "content"],
    additionalProperties: false,
  };
}

function singlePathInputSchema(): JsonSchema {
  return {
    type: "object",
    properties: {
      path: { type: "string", minLength: 1, maxLength: MAX_RELATIVE_PATH_LENGTH },
    },
    required: ["path"],
    additionalProperties: false,
  };
}

function moveInputSchema(): JsonSchema {
  return {
    type: "object",
    properties: {
      sourcePath: { type: "string", minLength: 1, maxLength: MAX_RELATIVE_PATH_LENGTH },
      destinationPath: {
        type: "string",
        minLength: 1,
        maxLength: MAX_RELATIVE_PATH_LENGTH,
      },
      overwrite: { type: "boolean", default: false },
    },
    required: ["sourcePath", "destinationPath"],
    additionalProperties: false,
  };
}

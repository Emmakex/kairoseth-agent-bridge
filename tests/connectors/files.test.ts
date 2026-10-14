import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BridgeRuntime,
  ConnectorRegistryAdapter,
  McpToolAdapter,
  ToolRegistry,
  createFilesConnector,
  type FileRootAccess,
  type FileRootDefinition,
  type PolicyEvaluator,
} from "../../src/index.js";

const noSecrets = {
  async getSecret(): Promise<string | null> {
    return null;
  },
};

const allowPolicy: PolicyEvaluator = {
  async evaluate() {
    return { outcome: "ALLOW", reason: "approved by test policy" };
  },
};

function rootDefinition(
  rootPath: string,
  access: FileRootAccess = "full",
  overrides: Partial<FileRootDefinition> = {},
): FileRootDefinition {
  return {
    id: "docs",
    path: rootPath,
    name: "Documents",
    description: "Declared document root.",
    localizations: {
      en: {
        name: "Documents",
        description: "Declared document root.",
      },
      es: {
        name: "Documentos",
        description: "Root declarado de documentos.",
      },
    },
    access,
    ...overrides,
  };
}

function register(root: FileRootDefinition) {
  const connector = createFilesConnector({ roots: [root] });
  const registry = new ToolRegistry();
  new ConnectorRegistryAdapter(registry, { sleep: async () => {} }).register({
    instanceId: "local",
    connector,
    config: {},
    secrets: noSecrets,
  });
  return { connector, registry };
}

async function tempRoot(t: { after(callback: () => void | Promise<void>): void }) {
  const base = await mkdtemp(path.join(tmpdir(), "kab-files-"));
  const root = path.join(base, "root");
  await mkdir(root);
  t.after(async () => {
    await rm(base, { recursive: true, force: true });
  });
  return { base, root };
}

async function exists(target: string): Promise<boolean> {
  try {
    await readFile(target);
    return true;
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      (error as { code?: string }).code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

test("Files root access controls tool surface and publishes ES/EN without exposing absolute paths", () => {
  const rootPath = path.resolve(tmpdir(), "kairoseth-files-contract-root");
  const readConnector = createFilesConnector({
    roots: [rootDefinition(rootPath, "read")],
  });

  assert.deepEqual(
    readConnector.tools.map((tool) => [tool.id, tool.risk]),
    [
      ["docs.list", "READ"],
      ["docs.read", "READ"],
    ],
  );
  assert.doesNotMatch(JSON.stringify(readConnector.manifest), new RegExp(escapeRegex(rootPath)));
  assert.equal(readConnector.manifest.localizations?.es?.name, "Archivos");
  assert.equal(readConnector.manifest.localizations?.en?.name, "Files");

  const fullConnector = createFilesConnector({
    roots: [rootDefinition(rootPath, "full")],
  });
  assert.deepEqual(
    fullConnector.tools.map((tool) => [tool.id, tool.risk]),
    [
      ["docs.list", "READ"],
      ["docs.read", "READ"],
      ["docs.write", "WRITE"],
      ["docs.delete", "CRITICAL"],
      ["docs.move", "CRITICAL"],
    ],
  );
  assert.deepEqual(fullConnector.manifest.capabilities, [
    "files.critical",
    "files.read",
    "files.write",
  ]);
});

test("Files list hides dotfiles and read returns bounded UTF-8/base64 content with SHA-256", async (t) => {
  const { root } = await tempRoot(t);
  await writeFile(path.join(root, "hello.txt"), "hello", "utf8");
  await writeFile(path.join(root, ".env"), "SECRET=1", "utf8");
  await mkdir(path.join(root, "nested"));

  const { registry } = register(rootDefinition(root, "read"));
  const bridge = new BridgeRuntime({ registry });

  const list = await bridge.invoke(
    "files.local.docs.list",
    {},
    { correlationId: "corr-files-list", actor: "agent-files" },
  );
  assert.equal(list.status, "executed");
  if (list.status === "executed") {
    assert.deepEqual(list.output, {
      entries: [
        { name: "hello.txt", path: "hello.txt", type: "file" },
        { name: "nested", path: "nested", type: "directory" },
      ],
      total: 2,
    });
  }

  const utf8 = await bridge.invoke(
    "files.local.docs.read",
    { path: "hello.txt" },
    { correlationId: "corr-files-read", actor: "agent-files" },
  );
  assert.equal(utf8.status, "executed");
  const digest = createHash("sha256").update("hello").digest("hex");
  if (utf8.status === "executed") {
    assert.deepEqual(utf8.output, {
      path: "hello.txt",
      size: 5,
      encoding: "utf8",
      content: "hello",
      sha256: digest,
    });
  }

  const base64 = await bridge.invoke(
    "files.local.docs.read",
    { path: "hello.txt", encoding: "base64" },
    { correlationId: "corr-files-read64", actor: "agent-files" },
  );
  assert.equal(base64.status, "executed");
  if (base64.status === "executed") {
    assert.equal((base64.output as { content: string }).content, Buffer.from("hello").toString("base64"));
  }
});

test("Files paths reject traversal, absolute paths, backslashes, colon streams and extra fields", async (t) => {
  const { base, root } = await tempRoot(t);
  await writeFile(path.join(base, "outside.txt"), "outside", "utf8");
  await writeFile(path.join(root, "inside.txt"), "inside", "utf8");
  const { registry } = register(rootDefinition(root, "read"));
  const bridge = new BridgeRuntime({ registry });

  for (const [index, candidate] of [
    "../outside.txt",
    "/etc/passwd",
    "..\\outside.txt",
    "inside.txt:stream",
    "./inside.txt",
  ].entries()) {
    const result = await bridge.invoke(
      "files.local.docs.read",
      { path: candidate },
      { correlationId: `corr-files-path-${index}`, actor: "agent-files" },
    );
    assert.equal(result.status, "failed");
  }

  const extra = await bridge.invoke(
    "files.local.docs.read",
    { path: "inside.txt", absolutePath: "/etc/passwd" },
    { correlationId: "corr-files-extra", actor: "agent-files" },
  );
  assert.equal(extra.status, "failed");
});

test("Files symlinks cannot escape a declared root for read or write", async (t) => {
  const { base, root } = await tempRoot(t);
  const outsideFile = path.join(base, "outside.txt");
  const outsideDir = path.join(base, "outside-dir");
  await writeFile(outsideFile, "outside", "utf8");
  await mkdir(outsideDir);
  await symlink(outsideFile, path.join(root, "escape.txt"));
  await symlink(outsideDir, path.join(root, "escape-dir"));

  const { registry } = register(rootDefinition(root, "full"));
  const readBridge = new BridgeRuntime({ registry });
  const read = await readBridge.invoke(
    "files.local.docs.read",
    { path: "escape.txt" },
    { correlationId: "corr-files-symlink-read", actor: "agent-files" },
  );
  assert.equal(read.status, "failed");

  const writeBridge = new BridgeRuntime({ registry, policy: allowPolicy });
  const write = await writeBridge.invoke(
    "files.local.docs.write",
    { path: "escape-dir/pwn.txt", content: "blocked" },
    { correlationId: "corr-files-symlink-write", actor: "approved-agent" },
  );
  assert.equal(write.status, "failed");
  assert.equal(await exists(path.join(outsideDir, "pwn.txt")), false);
});

test("Files extension allowlist and read/write byte bounds are enforced", async (t) => {
  const { root } = await tempRoot(t);
  await writeFile(path.join(root, "five.txt"), "12345", "utf8");
  await writeFile(path.join(root, "data.json"), "{}", "utf8");

  const { registry } = register(
    rootDefinition(root, "write", {
      allowedExtensions: [".txt"],
      maxReadBytes: 4,
      maxWriteBytes: 4,
    }),
  );
  const bridge = new BridgeRuntime({ registry, policy: allowPolicy });

  const tooLargeRead = await bridge.invoke(
    "files.local.docs.read",
    { path: "five.txt" },
    { correlationId: "corr-files-read-bound", actor: "agent-files" },
  );
  const badExtensionRead = await bridge.invoke(
    "files.local.docs.read",
    { path: "data.json" },
    { correlationId: "corr-files-ext-read", actor: "agent-files" },
  );
  const tooLargeWrite = await bridge.invoke(
    "files.local.docs.write",
    { path: "new.txt", content: "12345" },
    { correlationId: "corr-files-write-bound", actor: "approved-agent" },
  );
  const badExtensionWrite = await bridge.invoke(
    "files.local.docs.write",
    { path: "new.json", content: "{}" },
    { correlationId: "corr-files-ext-write", actor: "approved-agent" },
  );

  assert.equal(tooLargeRead.status, "failed");
  assert.equal(badExtensionRead.status, "failed");
  assert.equal(tooLargeWrite.status, "failed");
  assert.equal(badExtensionWrite.status, "failed");
  assert.equal(await exists(path.join(root, "new.txt")), false);
  assert.equal(await exists(path.join(root, "new.json")), false);
});

test("Files WRITE and CRITICAL tools require approval before filesystem mutation", async (t) => {
  const { root } = await tempRoot(t);
  await writeFile(path.join(root, "source.txt"), "source", "utf8");
  const { registry } = register(rootDefinition(root, "full"));
  const bridge = new BridgeRuntime({ registry });

  const write = await bridge.invoke(
    "files.local.docs.write",
    { path: "created.txt", content: "created" },
    { correlationId: "corr-files-write-approval", actor: "agent-files" },
  );
  const remove = await bridge.invoke(
    "files.local.docs.delete",
    { path: "source.txt" },
    { correlationId: "corr-files-delete-approval", actor: "agent-files" },
  );
  const move = await bridge.invoke(
    "files.local.docs.move",
    { sourcePath: "source.txt", destinationPath: "moved.txt" },
    { correlationId: "corr-files-move-approval", actor: "agent-files" },
  );

  assert.equal(write.status, "approval_required");
  assert.equal(remove.status, "approval_required");
  assert.equal(move.status, "approval_required");
  assert.equal(await exists(path.join(root, "created.txt")), false);
  assert.equal(await readFile(path.join(root, "source.txt"), "utf8"), "source");
  assert.equal(await exists(path.join(root, "moved.txt")), false);
});

test("approved Files write requires explicit overwrite and move/delete stay inside the same root", async (t) => {
  const { root } = await tempRoot(t);
  const { registry } = register(rootDefinition(root, "full"));
  const bridge = new BridgeRuntime({ registry, policy: allowPolicy });

  const created = await bridge.invoke(
    "files.local.docs.write",
    { path: "a.txt", content: "one" },
    { correlationId: "corr-files-create", actor: "approved-agent" },
  );
  assert.equal(created.status, "executed");
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "one");

  const accidentalOverwrite = await bridge.invoke(
    "files.local.docs.write",
    { path: "a.txt", content: "two" },
    { correlationId: "corr-files-no-overwrite", actor: "approved-agent" },
  );
  assert.equal(accidentalOverwrite.status, "failed");
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "one");

  const overwritten = await bridge.invoke(
    "files.local.docs.write",
    { path: "a.txt", content: "two", overwrite: true },
    { correlationId: "corr-files-overwrite", actor: "approved-agent" },
  );
  assert.equal(overwritten.status, "executed");
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "two");

  const moved = await bridge.invoke(
    "files.local.docs.move",
    { sourcePath: "a.txt", destinationPath: "b.txt" },
    { correlationId: "corr-files-move", actor: "approved-agent" },
  );
  assert.equal(moved.status, "executed");
  assert.equal(await exists(path.join(root, "a.txt")), false);
  assert.equal(await readFile(path.join(root, "b.txt"), "utf8"), "two");

  const deleted = await bridge.invoke(
    "files.local.docs.delete",
    { path: "b.txt" },
    { correlationId: "corr-files-delete", actor: "approved-agent" },
  );
  assert.equal(deleted.status, "executed");
  assert.equal(await exists(path.join(root, "b.txt")), false);
});

test("Files root declarations validate absolute paths and mandatory ES/EN metadata", () => {
  assert.throws(
    () =>
      createFilesConnector({
        roots: [rootDefinition("relative/path", "read")],
      }),
    /path must be absolute/i,
  );

  assert.throws(
    () =>
      createFilesConnector({
        roots: [
          rootDefinition(path.resolve(tmpdir(), "files-missing-es"), "read", {
            id: "missing-es",
            localizations: {
              en: {
                name: "English only",
                description: "Spanish is intentionally omitted in this validation test.",
              },
            },
          }),
        ],
      }),
    /requires ES name and description/i,
  );
});

test("Files MCP discovery localizes root tools in ES and EN", async (t) => {
  const { root } = await tempRoot(t);
  const { registry } = register(rootDefinition(root, "read"));
  const mcp = new McpToolAdapter(new BridgeRuntime({ registry }));

  assert.equal(
    mcp.getTool("files.local.docs.read", "es")?.title,
    "Leer archivo de Documentos",
  );
  assert.equal(
    mcp.getTool("files.local.docs.read", "en")?.title,
    "Read file from Documents",
  );
});

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

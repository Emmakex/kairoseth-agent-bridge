import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  EncryptedLocalQueue,
  InMemoryLocalQueueKeyProvider,
} from "../../src/index.js";

async function workspace(): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(join(tmpdir(), "kab-encrypted-queue-"));
  return { dir, file: join(dir, "queue.enc.json") };
}

function key(keyId: string) {
  return { keyId, key: randomBytes(32) };
}

test("encrypted local queue survives restart without storing payload plaintext", async (t) => {
  const { dir, file } = await workspace();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  const provider = new InMemoryLocalQueueKeyProvider(key("key-1"));
  const queue = new EncryptedLocalQueue<{ secret: string; orderId: number }>(
    file,
    provider,
    { scope: "tenant-1/installation-1" },
  );

  await queue.enqueue({
    id: "event-1",
    kind: "audit.retry",
    payload: { secret: "DO_NOT_STORE_IN_PLAINTEXT", orderId: 42 },
    ttlMs: 60_000,
  });

  const raw = await readFile(file, "utf8");
  assert.doesNotMatch(raw, /DO_NOT_STORE_IN_PLAINTEXT/);
  assert.doesNotMatch(raw, /orderId/);
  const envelope = JSON.parse(raw) as Record<string, unknown>;
  assert.equal(envelope.version, "kab.encrypted-local-queue.v1");
  assert.equal(envelope.algorithm, "A256GCM");
  assert.equal(envelope.keyId, "key-1");

  const restarted = new EncryptedLocalQueue<{ secret: string; orderId: number }>(
    file,
    provider,
    { scope: "tenant-1/installation-1" },
  );
  const items = await restarted.peek(10);
  assert.equal(items.length, 1);
  assert.deepEqual(items[0]?.payload, {
    secret: "DO_NOT_STORE_IN_PLAINTEXT",
    orderId: 42,
  });

  if (process.platform !== "win32") {
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
  }
});

test("ciphertext tampering and scope mismatch fail closed", async (t) => {
  const { dir, file } = await workspace();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  const provider = new InMemoryLocalQueueKeyProvider(key("key-1"));
  const queue = new EncryptedLocalQueue(file, provider, { scope: "scope-a" });
  await queue.enqueue({
    id: "item-1",
    kind: "command.retry",
    payload: { value: "protected" },
    ttlMs: 60_000,
  });

  const wrongScope = new EncryptedLocalQueue(file, provider, { scope: "scope-b" });
  await assert.rejects(() => wrongScope.peek(1), /authentication or decryption failed/i);

  const envelope = JSON.parse(await readFile(file, "utf8")) as {
    ciphertext: string;
  } & Record<string, unknown>;
  assert.ok(envelope.ciphertext.length > 2);
  const first = envelope.ciphertext[0] === "A" ? "B" : "A";
  envelope.ciphertext = `${first}${envelope.ciphertext.slice(1)}`;
  await writeFile(file, `${JSON.stringify(envelope)}\n`, "utf8");

  await assert.rejects(() => queue.peek(1), /authentication or decryption failed/i);
});

test("queue enforces TTL, item count and payload limits", async (t) => {
  const { dir, file } = await workspace();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  let nowMs = Date.parse("2026-10-14T08:00:00.000Z");
  const provider = new InMemoryLocalQueueKeyProvider(key("key-1"));
  const queue = new EncryptedLocalQueue(file, provider, {
    scope: "bounded",
    maxItems: 1,
    maxPayloadBytes: 64,
    maxTtlMs: 10_000,
    now: () => new Date(nowMs),
  });

  await assert.rejects(
    () =>
      queue.enqueue({
        id: "too-large",
        kind: "test",
        payload: { value: "x".repeat(100) },
        ttlMs: 1_000,
      }),
    /payload exceeds/i,
  );

  await queue.enqueue({
    id: "item-1",
    kind: "test",
    payload: { value: 1 },
    ttlMs: 1_000,
  });
  await assert.rejects(
    () =>
      queue.enqueue({
        id: "item-2",
        kind: "test",
        payload: { value: 2 },
        ttlMs: 1_000,
      }),
    /item limit reached/i,
  );

  nowMs += 1_500;
  assert.equal(await queue.size(), 0);
  await queue.enqueue({
    id: "item-2",
    kind: "test",
    payload: { value: 2 },
    ttlMs: 1_000,
  });
  assert.equal(await queue.size(), 1);
});

test("rewrap rotates encryption key while preserving queued state", async (t) => {
  const { dir, file } = await workspace();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  const firstKey = key("key-1");
  const provider = new InMemoryLocalQueueKeyProvider(firstKey);
  const queue = new EncryptedLocalQueue(file, provider, { scope: "rotation" });
  await queue.enqueue({
    id: "item-1",
    kind: "delivery.retry",
    payload: { attempt: 1 },
    ttlMs: 60_000,
  });

  const secondKey = key("key-2");
  provider.addKey(secondKey, true);
  await queue.rewrap();

  const envelope = JSON.parse(await readFile(file, "utf8")) as {
    keyId?: unknown;
  };
  assert.equal(envelope.keyId, "key-2");

  provider.removeKey("key-1");
  const restarted = new EncryptedLocalQueue(file, provider, { scope: "rotation" });
  assert.deepEqual((await restarted.peek(1))[0]?.payload, { attempt: 1 });
});

test("acknowledgement removes only explicitly acknowledged items", async (t) => {
  const { dir, file } = await workspace();
  t.after(async () => rm(dir, { recursive: true, force: true }));

  const queue = new EncryptedLocalQueue(
    file,
    new InMemoryLocalQueueKeyProvider(key("key-1")),
    { scope: "ack", maxItems: 10 },
  );
  await queue.enqueue({ id: "a", kind: "test", payload: { n: 1 }, ttlMs: 60_000 });
  await queue.enqueue({ id: "b", kind: "test", payload: { n: 2 }, ttlMs: 60_000 });

  assert.equal(await queue.acknowledge(["a"]), 1);
  assert.deepEqual(
    (await queue.peek(10)).map((item) => item.id),
    ["b"],
  );
  assert.equal(await queue.acknowledge(["missing"]), 0);
});

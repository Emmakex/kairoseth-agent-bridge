import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FileRuntimeProcessStatusStore,
  ProductionRuntime,
  loadRuntimeProcessConfig,
} from "../../src/index.js";

test("runtime process config defaults to a local durable deployment", () => {
  const config = loadRuntimeProcessConfig({
    KAB_PLATFORM_BASE_URL: "https://kairoseth.example",
    KAB_STATE_DIR: "./state-test",
  });

  assert.equal(config.platformBaseUrl, "https://kairoseth.example/");
  assert.equal(config.deploymentMode, "local");
  assert.equal(config.allowInsecureHttp, false);
  assert.ok(config.stateDir.endsWith("state-test"));
});

test("runtime process config rejects insecure remote control-plane URLs by default", () => {
  assert.throws(
    () =>
      loadRuntimeProcessConfig({
        KAB_PLATFORM_BASE_URL: "http://platform.example",
      }),
    /requires HTTPS outside localhost/,
  );
});

test("runtime process config permits explicit controlled HTTP opt-in", () => {
  const config = loadRuntimeProcessConfig({
    KAB_PLATFORM_BASE_URL: "http://platform.example",
    KAB_ALLOW_INSECURE_HTTP: "true",
    KAB_DEPLOYMENT_MODE: "hybrid",
  });

  assert.equal(config.allowInsecureHttp, true);
  assert.equal(config.deploymentMode, "hybrid");
});

test("runtime process status is atomic, fresh and process-aware", async () => {
  const root = await mkdtemp(join(tmpdir(), "kab-process-status-"));
  const path = join(root, "runtime", "status.json");

  try {
    const now = new Date("2026-10-15T04:00:00.000Z");
    const store = new FileRuntimeProcessStatusStore(path, () => now);
    await store.write("ready", "1.2.3", 4242);

    assert.equal(
      await store.healthy({
        now: () => new Date("2026-10-15T04:00:30.000Z"),
        isProcessAlive: (pid) => pid === 4242,
      }),
      true,
    );
    assert.equal(
      await store.healthy({
        now: () => new Date("2026-10-15T04:02:00.001Z"),
        isProcessAlive: () => true,
      }),
      false,
    );
    assert.equal(
      await store.healthy({
        now: () => new Date("2026-10-15T04:00:30.000Z"),
        isProcessAlive: () => false,
      }),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("starting and failed process states never pass healthcheck", async () => {
  const root = await mkdtemp(join(tmpdir(), "kab-process-state-"));
  const path = join(root, "runtime", "status.json");

  try {
    const store = new FileRuntimeProcessStatusStore(path);
    await store.write("starting", "1.2.3", process.pid);
    assert.equal(await store.healthy(), false);

    await store.write("failed", "1.2.3", process.pid);
    assert.equal(await store.healthy(), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("production runtime persists identity and fails closed before enrollment", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "kab-production-runtime-"));

  try {
    const runtime = new ProductionRuntime({
      platformBaseUrl: "https://kairoseth.example",
      stateDir,
      runtimeVersion: "1.2.3",
      deploymentMode: "local",
    });

    const first = await runtime.publicIdentity();
    const second = await runtime.publicIdentity();
    assert.equal(first.bridgeInstanceId, second.bridgeInstanceId);
    assert.equal(first.keyId, second.keyId);
    assert.equal(await runtime.enrollment(), null);
    assert.equal(await runtime.readiness(), "ready");

    await assert.rejects(runtime.run(), /not enrolled/);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

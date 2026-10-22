import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { InstallationBinding } from "../../src/control-channel/enrollment.js";
import type { PublicBridgeIdentity } from "../../src/identity/installation-identity.js";
import {
  loadPhase7RealPlatformAcceptanceConfig,
  runPhase7RealPlatformAcceptance,
  type Phase7RealPlatformAcceptanceConfig,
} from "../../src/acceptance/phase7-real-platform.js";

const identity: PublicBridgeIdentity = {
  version: "kab.identity.v1",
  bridgeInstanceId: "bridge-phase7-runner",
  keyId: "bridge-key-phase7-runner",
  publicKeyPem: "-----BEGIN PUBLIC KEY-----\nfixture\n-----END PUBLIC KEY-----\n",
  createdAt: "2026-10-19T12:00:00.000Z",
};

const binding: InstallationBinding = {
  version: "kab.installation-binding.v1",
  tenantId: "workspace-phase7",
  installationId: "installation-phase7",
  bridgeInstanceId: identity.bridgeInstanceId,
  keyId: identity.keyId,
  registeredAt: "2026-10-19T12:01:00.000Z",
  trustedApprovalKeys: [
    {
      keyId: "approval-key-phase7",
      publicKeyPem: "-----BEGIN PUBLIC KEY-----\napproval\n-----END PUBLIC KEY-----\n",
    },
  ],
};

async function secretFile(root: string, name: string, value: string): Promise<string> {
  const path = join(root, name);
  await writeFile(path, `${value}\n`, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") await chmod(path, 0o600);
  return path;
}

test("Phase 7 config requires file-backed secrets and normalizes safe inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "kab-phase7-runner-config-"));
  try {
    const operatorFile = await secretFile(root, "operator", "operator-fixture");
    const consumerKeyFile = await secretFile(root, "consumer-key", "ck_fixture");
    const consumerSecretFile = await secretFile(root, "consumer-secret", "cs_fixture");
    const stateDir = join(root, "state");

    const config = await loadPhase7RealPlatformAcceptanceConfig({
      KAB_PLATFORM_BASE_URL: "https://platform.example",
      KAB_STATE_DIR: stateDir,
      KAB_ACCEPTANCE_RUNTIME_VERSION: "0.1.0",
      KAB_ACCEPTANCE_ARTIFACT_SHA256: "a".repeat(64),
      KAB_ACCEPTANCE_OPERATOR_TOKEN_FILE: operatorFile,
      KAB_ACCEPTANCE_WC_BASE_URL: "https://shop.example.com",
      KAB_ACCEPTANCE_WC_CONSUMER_KEY_FILE: consumerKeyFile,
      KAB_ACCEPTANCE_WC_CONSUMER_SECRET_FILE: consumerSecretFile,
      KAB_ACCEPTANCE_WC_ORDER_ID: "42",
      KAB_ACCEPTANCE_WC_EXPECTED_STATUS: "processing",
      KAB_ACCEPTANCE_WC_TARGET_STATUS: "completed",
    });

    assert.equal(config.platformBaseUrl, "https://platform.example/");
    assert.equal(config.operatorToken, "operator-fixture");
    assert.equal(config.wooCommerceConsumerKey, "ck_fixture");
    assert.equal(config.wooCommerceConsumerSecret, "cs_fixture");
    assert.equal(config.wooCommerceOrderId, 42);
    assert.equal(config.artifactSha256, `sha256:${"a".repeat(64)}`);

    await assert.rejects(
      loadPhase7RealPlatformAcceptanceConfig({
        KAB_ACCEPTANCE_OPERATOR_TOKEN: "forbidden-direct-secret",
      }),
      /forbidden.*files only/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Phase 7 runner proves real-Platform orchestration without retaining secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "kab-phase7-runner-flow-"));
  const stateDir = join(root, "state");
  const evidencePath = join(root, "evidence", "phase7.json");
  await mkdir(join(stateDir, "audit"), { recursive: true });
  await writeFile(
    join(stateDir, "audit", "outbox.json"),
    `${JSON.stringify({ version: "kab.audit-outbox.v1", events: [] })}\n`,
    "utf8",
  );

  const config: Phase7RealPlatformAcceptanceConfig = {
    platformBaseUrl: "https://platform.example/",
    stateDir,
    runtimeVersion: "0.1.0",
    artifactSha256: `sha256:${"b".repeat(64)}`,
    operatorToken: "operator-fixture-token",
    wooCommerceBaseUrl: "https://shop.example.com/",
    wooCommerceConsumerKey: "ck_fixture_sensitive",
    wooCommerceConsumerSecret: "cs_fixture_sensitive",
    wooCommerceOrderId: 42,
    expectedOrderStatus: "processing",
    targetOrderStatus: "completed",
    allowPrivateWooCommerceNetwork: false,
    allowInsecurePlatformHttp: false,
    timeoutMs: 10_000,
    evidencePath,
  };

  let enrolled = false;
  let runtimeRuns = 0;
  const runtimeFactory = () => ({
    async publicIdentity() {
      return identity;
    },
    async enrollment() {
      return enrolled ? binding : null;
    },
    async enroll(token: string) {
      assert.equal(token, "one-time-enrollment-token");
      enrolled = true;
      return binding;
    },
    async run(signal?: AbortSignal) {
      runtimeRuns += 1;
      if (signal?.aborted) return;
      await new Promise<void>((resolve) => {
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    },
  });

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input.toString() : input.url,
    );
    const authorization = new Headers(init?.headers).get("authorization");
    assert.equal(authorization, "Bearer operator-fixture-token");

    if (url.pathname === "/v1/session") {
      return json({ activeWorkspaceId: "workspace-phase7" });
    }
    if (url.pathname === "/v1/products/agent-bridge/enrollment-tokens") {
      return json({ token: "one-time-enrollment-token" });
    }
    if (url.pathname === "/v1/products/agent-bridge/runtime-observability") {
      return json({
        summary: {
          installations: [
            {
              installationId: binding.installationId,
              connectivity: "connected",
              readiness: "ready",
              runtimeVersion: "0.1.0",
              deploymentMode: "local",
              connectors: { total: 1 },
              tools: { total: 6 },
            },
          ],
        },
      });
    }
    if (
      init?.method === "POST" &&
      url.pathname.endsWith(`/installations/${binding.installationId}/commands`)
    ) {
      return json({
        command: {
          commandId: "read-command",
          state: "queued",
          deliveryAttempt: 0,
        },
      }, 201);
    }
    if (
      init?.method === "POST" &&
      url.pathname.endsWith(`/installations/${binding.installationId}/approved-commands`)
    ) {
      return json({
        command: {
          commandId: "write-command",
          state: "queued",
          deliveryAttempt: 0,
        },
      }, 201);
    }
    if (url.pathname.endsWith("/commands/read-command")) {
      return json({
        command: {
          commandId: "read-command",
          state: "completed",
          deliveryAttempt: 1,
          acknowledgement: { status: "executed", output: { id: 42, status: "processing" } },
        },
      });
    }
    if (url.pathname.endsWith("/commands/write-command")) {
      return json({
        command: {
          commandId: "write-command",
          state: "completed",
          deliveryAttempt: 1,
          acknowledgement: { status: "executed", output: { id: 42, status: "completed" } },
        },
      });
    }
    return json({ code: "unexpected_test_endpoint" }, 404);
  }) as typeof globalThis.fetch;

  try {
    const evidence = await runPhase7RealPlatformAcceptance(config, {
      fetch: fetchImpl,
      runtimeFactory,
      now: () => new Date("2026-10-19T12:30:00.000Z"),
      sleep: async () => {},
    });

    assert.equal(evidence.result, "passed");
    assert.equal(evidence.read.status, "executed");
    assert.equal(evidence.write.status, "executed");
    assert.equal(evidence.restart.identityPreserved, true);
    assert.equal(evidence.restart.bindingPreserved, true);
    assert.equal(evidence.restart.completedCommandsNotRedelivered, true);
    assert.equal(evidence.auditOutboxDrained, true);
    assert.equal(evidence.durableStateSecretScan, "passed");
    assert.equal(runtimeRuns, 2);

    const persistedEvidence = await readFile(evidencePath, "utf8");
    for (const secret of [
      config.operatorToken,
      config.wooCommerceConsumerKey,
      config.wooCommerceConsumerSecret,
    ]) {
      assert.equal(persistedEvidence.includes(secret), false);
    }
    assert.equal(persistedEvidence.includes("42"), false, "order ID must not enter evidence");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Phase 7 runner fails if durable state contains approval or connector credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "kab-phase7-runner-secret-scan-"));
  const stateDir = join(root, "state");
  await mkdir(join(stateDir, "audit"), { recursive: true });
  await writeFile(
    join(stateDir, "audit", "outbox.json"),
    `${JSON.stringify({ version: "kab.audit-outbox.v1", events: [] })}\n`,
    "utf8",
  );
  await writeFile(join(stateDir, "leak.json"), JSON.stringify({ approvalToken: "kab1.a.b.c" }), "utf8");

  const config: Phase7RealPlatformAcceptanceConfig = {
    platformBaseUrl: "https://platform.example/",
    stateDir,
    runtimeVersion: "0.1.0",
    operatorToken: "operator-fixture-token",
    wooCommerceBaseUrl: "https://shop.example.com/",
    wooCommerceConsumerKey: "ck_fixture_sensitive",
    wooCommerceConsumerSecret: "cs_fixture_sensitive",
    wooCommerceOrderId: 42,
    expectedOrderStatus: "processing",
    targetOrderStatus: "completed",
    allowPrivateWooCommerceNetwork: false,
    allowInsecurePlatformHttp: false,
    timeoutMs: 10_000,
  };

  let enrolled = false;
  const runtimeFactory = () => ({
    async publicIdentity() {
      return identity;
    },
    async enrollment() {
      return enrolled ? binding : null;
    },
    async enroll() {
      enrolled = true;
      return binding;
    },
    async run(signal?: AbortSignal) {
      await new Promise<void>((resolve) => {
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    },
  });
  const fetchImpl = successfulPlatformFetch();

  try {
    await assert.rejects(
      runPhase7RealPlatformAcceptance(config, {
        fetch: fetchImpl,
        runtimeFactory,
        sleep: async () => {},
      }),
      /durable Agent Bridge state contains acceptance credential material/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function successfulPlatformFetch(): typeof globalThis.fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input.toString() : input.url,
    );
    if (url.pathname === "/v1/session") return json({ activeWorkspaceId: "workspace-phase7" });
    if (url.pathname === "/v1/products/agent-bridge/enrollment-tokens") {
      return json({ token: "one-time-enrollment-token" });
    }
    if (url.pathname === "/v1/products/agent-bridge/runtime-observability") {
      return json({
        summary: {
          installations: [
            {
              installationId: binding.installationId,
              connectivity: "connected",
              readiness: "ready",
              runtimeVersion: "0.1.0",
              deploymentMode: "local",
              connectors: { total: 1 },
              tools: { total: 6 },
            },
          ],
        },
      });
    }
    if (init?.method === "POST" && url.pathname.endsWith("/commands")) {
      return json({
        command: { commandId: "read-command", correlationId: "read", state: "queued", deliveryAttempt: 0 },
      }, 201);
    }
    if (init?.method === "POST" && url.pathname.endsWith("/approved-commands")) {
      return json({
        command: { commandId: "write-command", correlationId: "write", state: "queued", deliveryAttempt: 0 },
      }, 201);
    }
    if (url.pathname.endsWith("/commands/read-command")) {
      return json({
        command: {
          commandId: "read-command",
          state: "completed",
          deliveryAttempt: 1,
          acknowledgement: { status: "executed", output: { status: "processing" } },
        },
      });
    }
    if (url.pathname.endsWith("/commands/write-command")) {
      return json({
        command: {
          commandId: "write-command",
          state: "completed",
          deliveryAttempt: 1,
          acknowledgement: { status: "executed", output: { status: "completed" } },
        },
      });
    }
    return json({ code: "unexpected_test_endpoint" }, 404);
  }) as typeof globalThis.fetch;
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

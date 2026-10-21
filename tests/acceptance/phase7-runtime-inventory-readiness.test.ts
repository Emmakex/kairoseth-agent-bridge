import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  runPhase7RealPlatformAcceptance,
  type Phase7RealPlatformAcceptanceConfig,
} from "../../src/acceptance/phase7-real-platform.js";
import type { InstallationBinding } from "../../src/control-channel/enrollment.js";
import type { PublicBridgeIdentity } from "../../src/identity/installation-identity.js";

const identity: PublicBridgeIdentity = {
  version: "kab.identity.v1",
  bridgeInstanceId: "bridge-inventory-race",
  keyId: "bridge-key-inventory-race",
  publicKeyPem: "-----BEGIN PUBLIC KEY-----\nfixture\n-----END PUBLIC KEY-----\n",
  createdAt: "2026-10-21T03:00:00.000Z",
};

const binding: InstallationBinding = {
  version: "kab.installation-binding.v1",
  tenantId: "workspace-inventory-race",
  installationId: "installation-inventory-race",
  bridgeInstanceId: identity.bridgeInstanceId,
  keyId: identity.keyId,
  registeredAt: "2026-10-21T03:01:00.000Z",
  trustedApprovalKeys: [],
};

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("Phase 7 waits for runtime inventory before queuing a real command", async () => {
  const root = await mkdtemp(join(tmpdir(), "kab-phase7-inventory-race-"));
  const stateDir = join(root, "state");
  await mkdir(join(stateDir, "audit"), { recursive: true });
  await writeFile(
    join(stateDir, "audit", "outbox.json"),
    `${JSON.stringify({ version: "kab.audit-outbox.v1", events: [] })}\n`,
    "utf8",
  );

  const config: Phase7RealPlatformAcceptanceConfig = {
    platformBaseUrl: "https://platform.example/",
    stateDir,
    runtimeVersion: "0.1.2",
    operatorToken: "operator-inventory-race",
    wooCommerceBaseUrl: "https://shop.example.com/",
    wooCommerceConsumerKey: "ck_inventory_race",
    wooCommerceConsumerSecret: "cs_inventory_race",
    wooCommerceOrderId: 42,
    expectedOrderStatus: "processing",
    targetOrderStatus: "completed",
    allowPrivateWooCommerceNetwork: false,
    allowInsecurePlatformHttp: false,
    timeoutMs: 10_000,
  };

  let enrolled = false;
  let observabilityCalls = 0;
  let readQueued = false;
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

    if (url.pathname === "/v1/session") {
      return json({ activeWorkspaceId: binding.tenantId });
    }
    if (url.pathname === "/v1/products/agent-bridge/enrollment-tokens") {
      return json({ token: "inventory-race-token" });
    }
    if (url.pathname === "/v1/products/agent-bridge/runtime-observability") {
      observabilityCalls += 1;
      const inventoryReady = observabilityCalls > 1;
      return json({
        summary: {
          installations: [
            {
              installationId: binding.installationId,
              connectivity: "connected",
              readiness: "ready",
              runtimeVersion: config.runtimeVersion,
              deploymentMode: "local",
              connectors: { total: inventoryReady ? 1 : 0 },
              tools: { total: inventoryReady ? 6 : 0 },
            },
          ],
        },
      });
    }
    if (
      init?.method === "POST" &&
      url.pathname.endsWith(`/installations/${binding.installationId}/commands`)
    ) {
      assert.ok(
        observabilityCalls >= 2,
        "READ must not be queued while Platform still reports zero connector/tool inventory",
      );
      const body = JSON.parse(String(init.body)) as { toolId?: string };
      assert.equal(body.toolId, "woocommerce.store.orders.get");
      readQueued = true;
      return json({
        command: {
          commandId: "read-inventory-race",
          correlationId: "read-inventory-race",
          state: "queued",
          deliveryAttempt: 0,
        },
      }, 201);
    }
    if (
      init?.method === "POST" &&
      url.pathname.endsWith(`/installations/${binding.installationId}/approved-commands`)
    ) {
      assert.equal(readQueued, true);
      return json({
        command: {
          commandId: "write-inventory-race",
          correlationId: "write-inventory-race",
          state: "queued",
          deliveryAttempt: 0,
        },
      }, 201);
    }
    if (url.pathname.endsWith("/commands/read-inventory-race")) {
      return json({
        command: {
          commandId: "read-inventory-race",
          correlationId: "read-inventory-race",
          state: "completed",
          deliveryAttempt: 1,
          acknowledgement: { status: "executed", output: { status: "processing" } },
        },
      });
    }
    if (url.pathname.endsWith("/commands/write-inventory-race")) {
      return json({
        command: {
          commandId: "write-inventory-race",
          correlationId: "write-inventory-race",
          state: "completed",
          deliveryAttempt: 1,
          acknowledgement: { status: "executed", output: { status: "completed" } },
        },
      });
    }

    return json({ code: "unexpected_inventory_race_endpoint" }, 404);
  }) as typeof globalThis.fetch;

  try {
    const evidence = await runPhase7RealPlatformAcceptance(config, {
      fetch: fetchImpl,
      runtimeFactory,
      now: () => new Date("2026-10-21T03:30:00.000Z"),
      sleep: async () => {},
    });

    assert.equal(evidence.result, "passed");
    assert.equal(readQueued, true);
    assert.ok(observabilityCalls >= 3, "restart must also wait for an inventory-backed observation");
    assert.ok(evidence.observability.beforeRestart.connectorCount > 0);
    assert.ok(evidence.observability.beforeRestart.toolCount > 0);
    assert.ok(evidence.observability.afterRestart.connectorCount > 0);
    assert.ok(evidence.observability.afterRestart.toolCount > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

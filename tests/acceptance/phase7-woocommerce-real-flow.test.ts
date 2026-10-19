import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ProductionRuntime,
  canonicalJson,
  connectorRuntimeToolId,
  createActionFingerprint,
  createWooCommerceConnector,
  type ApprovalPayload,
  type ConnectorInstance,
  type GenericRestHttpRuntime,
  type InstallationBinding,
} from "../../src/index.js";

const APPROVAL_KEY_ID = "platform-phase7-approval-key";
const READ_TOOL_ID = connectorRuntimeToolId("woocommerce", "store", "orders.list");
const WRITE_TOOL_ID = connectorRuntimeToolId(
  "woocommerce",
  "store",
  "orders.update-status",
);

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function waitUntil(
  predicate: () => boolean,
  message: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("Phase 7 real flow survives restart without replaying WooCommerce side effects", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "kab-phase7-woocommerce-"));
  const approvalPair = generateKeyPairSync("ed25519");
  let binding: InstallationBinding | null = null;
  let sessionSequence = 0;
  const pullCounts = new Map<number, number>();
  const acknowledgements: Array<Record<string, unknown> & { run: number }> = [];
  const deliveredAuditEvents: Array<Record<string, unknown>> = [];
  const connectorCalls: Array<{
    method: string;
    path: string;
    query: string;
    body: string;
  }> = [];
  let snapshotCount = 0;
  let commandFixtures: readonly Record<string, unknown>[] = [];

  const connectorHttp: GenericRestHttpRuntime = {
    async resolveHost(hostname) {
      assert.equal(hostname, "shop.example.com");
      return ["93.184.216.34"];
    },
    async fetch(input, init) {
      const url = new URL(input);
      const method = init.method ?? "GET";
      const body = String(init.body ?? "");
      connectorCalls.push({
        method,
        path: url.pathname,
        query: url.search,
        body,
      });

      const headers = new Headers(init.headers);
      const expectedBasic = Buffer.from(
        "ck_phase7:cs_phase7",
        "utf8",
      ).toString("base64");
      assert.equal(headers.get("authorization"), `Basic ${expectedBasic}`);

      if (method === "GET" && url.pathname === "/wp-json/wc/v3/orders") {
        assert.equal(url.searchParams.get("per_page"), "1");
        return json([{ id: 42, status: "processing" }]);
      }

      if (method === "PUT" && url.pathname === "/wp-json/wc/v3/orders/42") {
        assert.deepEqual(JSON.parse(body), { status: "completed" });
        return json({ id: 42, status: "completed" });
      }

      return json({ code: "unexpected_woocommerce_endpoint" }, 404);
    },
  };

  const connector: ConnectorInstance = {
    instanceId: "store",
    connector: createWooCommerceConnector(
      { allowedOrigins: ["https://shop.example.com"] },
      connectorHttp,
    ),
    config: { baseUrl: "https://shop.example.com" },
    secrets: {
      async getSecret(requirementId, fieldId) {
        if (requirementId !== "woocommerce_api") return null;
        if (fieldId === "consumer_key") return "ck_phase7";
        if (fieldId === "consumer_secret") return "cs_phase7";
        return null;
      },
    },
  };

  function approvalToken(payload: ApprovalPayload): string {
    const keyId = Buffer.from(APPROVAL_KEY_ID, "utf8").toString("base64url");
    const encodedPayload = Buffer.from(canonicalJson(payload), "utf8").toString(
      "base64url",
    );
    const signingInput = `kab1.${keyId}.${encodedPayload}`;
    const signature = sign(
      null,
      Buffer.from(signingInput, "utf8"),
      approvalPair.privateKey,
    ).toString("base64url");
    return `${signingInput}.${signature}`;
  }

  function buildCommandFixtures(activeBinding: InstallationBinding) {
    const now = Date.now();
    const readInput = { perPage: 1 };
    const writeInput = { orderId: 42, status: "completed" };
    const readCorrelationId = "corr-phase7-woocommerce-read";
    const writeCorrelationId = "corr-phase7-woocommerce-write";
    const readFingerprint = createActionFingerprint({
      tenantId: activeBinding.tenantId,
      installationId: activeBinding.installationId,
      toolId: READ_TOOL_ID,
      correlationId: readCorrelationId,
      input: readInput,
    });
    const writeFingerprint = createActionFingerprint({
      tenantId: activeBinding.tenantId,
      installationId: activeBinding.installationId,
      toolId: WRITE_TOOL_ID,
      correlationId: writeCorrelationId,
      input: writeInput,
    });
    const token = approvalToken({
      version: "kab.approval.v1",
      decision: "ALLOW",
      tenantId: activeBinding.tenantId,
      installationId: activeBinding.installationId,
      toolId: WRITE_TOOL_ID,
      correlationId: writeCorrelationId,
      actionFingerprint: writeFingerprint,
      issuedAt: new Date(now - 5_000).toISOString(),
      expiresAt: new Date(now + 120_000).toISOString(),
      nonce: "phase7-woocommerce-write-once",
    });

    return [
      {
        version: "kab.command.v1",
        commandId: "phase7-read-command",
        deliveryAttempt: 1,
        tenantId: activeBinding.tenantId,
        installationId: activeBinding.installationId,
        bridgeInstanceId: activeBinding.bridgeInstanceId,
        correlationId: readCorrelationId,
        actor: "phase7-product-agent",
        toolId: READ_TOOL_ID,
        input: readInput,
        actionFingerprint: readFingerprint,
        issuedAt: new Date(now - 1_000).toISOString(),
        expiresAt: new Date(now + 120_000).toISOString(),
      },
      {
        version: "kab.command.v1",
        commandId: "phase7-write-command",
        deliveryAttempt: 1,
        tenantId: activeBinding.tenantId,
        installationId: activeBinding.installationId,
        bridgeInstanceId: activeBinding.bridgeInstanceId,
        correlationId: writeCorrelationId,
        actor: "phase7-product-agent",
        toolId: WRITE_TOOL_ID,
        input: writeInput,
        actionFingerprint: writeFingerprint,
        approvalToken: token,
        issuedAt: new Date(now - 1_000).toISOString(),
        expiresAt: new Date(now + 120_000).toISOString(),
      },
    ] as const;
  }

  const platformFetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(
      typeof input === "string" || input instanceof URL
        ? input.toString()
        : input.url,
    );
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : {};

    switch (url.pathname) {
      case "/api/products/agent-bridge/enrollment/challenge":
        return json({
          version: "kab.enrollment-challenge.v1",
          nonce: "phase7-enrollment-nonce",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });

      case "/api/products/agent-bridge/enrollment/register": {
        const proof = body.proof as {
          payload: { bridgeInstanceId: string; keyId: string };
        };
        binding = {
          version: "kab.installation-binding.v1",
          tenantId: "tenant-phase7",
          installationId: "installation-phase7-woocommerce",
          bridgeInstanceId: proof.payload.bridgeInstanceId,
          keyId: proof.payload.keyId,
          registeredAt: new Date().toISOString(),
          trustedApprovalKeys: [
            {
              keyId: APPROVAL_KEY_ID,
              publicKeyPem: approvalPair.publicKey
                .export({ format: "pem", type: "spki" })
                .toString(),
            },
          ],
        };
        commandFixtures = buildCommandFixtures(binding);
        return json({ binding });
      }

      case "/api/products/agent-bridge/session/challenge":
        return json({
          version: "kab.session-challenge.v1",
          nonce: `phase7-session-nonce-${sessionSequence + 1}`,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });

      case "/api/products/agent-bridge/session/open": {
        assert.ok(binding);
        sessionSequence += 1;
        const sessionId = `session-phase7-${sessionSequence}`;
        return json({
          credential: {
            version: "kab.session-credential.v1",
            sessionId,
            tenantId: binding.tenantId,
            installationId: binding.installationId,
            bridgeInstanceId: binding.bridgeInstanceId,
            keyId: binding.keyId,
            accessToken: `phase7-session-secret-${sessionSequence}`,
            issuedAt: new Date(Date.now() - 1_000).toISOString(),
            expiresAt: new Date(Date.now() + 300_000).toISOString(),
            heartbeatIntervalSeconds: 5,
          },
        });
      }

      case "/api/products/agent-bridge/session/heartbeat":
        return json({
          ack: {
            version: "kab.heartbeat-ack.v1",
            receivedAt: new Date().toISOString(),
            nextHeartbeatInSeconds: 5,
          },
        });

      case "/api/products/agent-bridge/runtime-snapshot": {
        snapshotCount += 1;
        const snapshot = body.snapshot as { snapshotId: string };
        return json({
          ack: {
            version: "kab.runtime-snapshot-ack.v1",
            snapshotId: snapshot.snapshotId,
            receivedAt: new Date().toISOString(),
          },
        });
      }

      case "/api/products/agent-bridge/approval-keys/sync":
        return json({ update: null });

      case "/api/products/agent-bridge/commands/pull": {
        assert.ok(binding);
        assert.ok(sessionSequence > 0);
        const count = (pullCounts.get(sessionSequence) ?? 0) + 1;
        pullCounts.set(sessionSequence, count);
        const commands = count <= commandFixtures.length
          ? [commandFixtures[count - 1]]
          : [];
        return json({
          batch: {
            version: "kab.command-batch.v1",
            batchId: `phase7-batch-${sessionSequence}-${count}`,
            sessionId: `session-phase7-${sessionSequence}`,
            commands,
          },
        });
      }

      case "/api/products/agent-bridge/commands/ack": {
        acknowledgements.push({
          ...(body.acknowledgement as Record<string, unknown>),
          run: sessionSequence,
        });
        return new Response(null, { status: 204 });
      }

      case "/api/products/agent-bridge/audit/batch": {
        const batch = body.batch as {
          batchId: string;
          events: Array<Record<string, unknown>>;
        };
        deliveredAuditEvents.push(...batch.events);
        return json({
          ack: {
            version: "kab.audit-batch-ack.v1",
            batchId: batch.batchId,
            acceptedEventIds: batch.events.map((event) => event.eventId),
          },
        });
      }

      default:
        return json({ code: "unexpected_phase7_platform_endpoint" }, 404);
    }
  }) as typeof globalThis.fetch;

  const options = {
    platformBaseUrl: "https://platform.example",
    stateDir,
    runtimeVersion: "0.1.0-phase7",
    deploymentMode: "local" as const,
    connectorInstances: [connector],
    fetch: platformFetch,
  };

  try {
    const firstRuntime = new ProductionRuntime(options);
    const identityBeforeEnrollment = await firstRuntime.publicIdentity();
    const enrolled = await firstRuntime.enroll("phase7-one-time-enrollment-token");
    assert.equal(enrolled.tenantId, "tenant-phase7");
    assert.equal(enrolled.installationId, "installation-phase7-woocommerce");

    const firstController = new AbortController();
    const firstRun = firstRuntime.run(firstController.signal);
    await waitUntil(
      () =>
        acknowledgements.filter((ack) => ack.run === 1).length >= 2 &&
        deliveredAuditEvents.length >= 2 &&
        snapshotCount >= 1,
      "Phase 7 first production flow did not complete.",
    );
    firstController.abort();
    await firstRun;

    const firstRunAcks = acknowledgements.filter((ack) => ack.run === 1);
    assert.deepEqual(
      firstRunAcks.map((ack) => ack.status),
      ["executed", "executed"],
    );
    assert.equal(connectorCalls.length, 2);
    assert.deepEqual(
      connectorCalls.map((call) => [call.method, call.path]),
      [
        ["GET", "/wp-json/wc/v3/orders"],
        ["PUT", "/wp-json/wc/v3/orders/42"],
      ],
    );

    const restartedRuntime = new ProductionRuntime(options);
    const identityAfterRestart = await restartedRuntime.publicIdentity();
    assert.deepEqual(identityAfterRestart, identityBeforeEnrollment);
    assert.deepEqual(await restartedRuntime.enrollment(), enrolled);

    const secondController = new AbortController();
    const secondRun = restartedRuntime.run(secondController.signal);
    await waitUntil(
      () =>
        acknowledgements.filter((ack) => ack.run === 2).length >= 2 &&
        snapshotCount >= 2,
      "Phase 7 restart did not complete command redelivery and observability.",
    );
    secondController.abort();
    await secondRun;

    const secondRunAcks = acknowledgements.filter((ack) => ack.run === 2);
    assert.deepEqual(
      secondRunAcks.map((ack) => ack.status),
      ["duplicate", "duplicate"],
    );
    assert.deepEqual(
      secondRunAcks.map((ack) => ack.originalOutcome),
      ["executed", "executed"],
    );
    assert.equal(
      connectorCalls.length,
      2,
      "restart redelivery must not repeat WooCommerce READ/WRITE side effects",
    );
    assert.ok(snapshotCount >= 2);

    const replayState = await readFile(
      join(stateDir, "security", "approval-replay.json"),
      "utf8",
    );
    const receiptState = await readFile(
      join(stateDir, "control", "command-receipts.json"),
      "utf8",
    );
    const auditState = await readFile(
      join(stateDir, "audit", "outbox.json"),
      "utf8",
    );
    const persistedState = `${replayState}\n${receiptState}\n${auditState}`;

    assert.match(replayState, /phase7-woocommerce-write-once/);
    assert.match(receiptState, /phase7-read-command/);
    assert.match(receiptState, /phase7-write-command/);
    assert.doesNotMatch(persistedState, /ck_phase7/);
    assert.doesNotMatch(persistedState, /cs_phase7/);
    assert.doesNotMatch(persistedState, /phase7-session-secret/);
    assert.doesNotMatch(persistedState, /kab1\./);
    assert.deepEqual(JSON.parse(auditState), {
      version: "kab.audit-outbox.v1",
      events: [],
    });
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

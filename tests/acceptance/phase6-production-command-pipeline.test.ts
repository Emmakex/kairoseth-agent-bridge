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
  type ApprovalPayload,
  type ConnectorInstance,
  type InstallationBinding,
} from "../../src/index.js";

const approvalPair = generateKeyPairSync("ed25519");
const APPROVAL_KEY_ID = "platform-approval-key-1";
const TOOL_ID = connectorRuntimeToolId("demo", "primary", "write");

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

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

test("production runtime executes one signed WRITE, rejects approval replay, and drains sanitized audit", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "kab-production-secure-"));
  const controller = new AbortController();
  let binding: InstallationBinding | null = null;
  let writeExecutions = 0;
  const commandAcks: Array<Record<string, unknown>> = [];
  const deliveredAuditEvents: Array<Record<string, unknown>> = [];
  let commandPulls = 0;
  let completeTest: (() => void) | undefined;
  const completed = new Promise<void>((resolve) => {
    completeTest = resolve;
  });

  const connector: ConnectorInstance = {
    instanceId: "primary",
    connector: {
      manifest: {
        id: "demo",
        name: "Demo connector",
        version: "1.0.0",
        description: "Secure production acceptance connector",
        localizations: {
          es: {
            name: "Conector de prueba",
            description: "Conector para aceptación segura de producción",
          },
          en: {
            name: "Demo connector",
            description: "Connector for secure production acceptance",
          },
        },
        capabilities: ["write"],
        credentials: [],
      },
      tools: [
        {
          id: "write",
          name: "Write value",
          description: "Acceptance WRITE operation",
          localizations: {
            es: {
              name: "Escribir valor",
              description: "Operación WRITE de aceptación",
            },
            en: {
              name: "Write value",
              description: "Acceptance WRITE operation",
            },
          },
          risk: "WRITE",
          inputSchema: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
            additionalProperties: false,
          },
          async execute(input) {
            writeExecutions += 1;
            return { ok: true, input };
          },
        },
      ],
    },
    secrets: {
      async getSecret() {
        return null;
      },
    },
  };

  const fakeFetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(
      typeof input === "string" || input instanceof URL
        ? input.toString()
        : input.url,
    );
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};

    switch (url.pathname) {
      case "/api/products/agent-bridge/enrollment/challenge":
        return json({
          version: "kab.enrollment-challenge.v1",
          nonce: "enrollment-nonce",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });

      case "/api/products/agent-bridge/enrollment/register": {
        const proof = body.proof as {
          payload: { bridgeInstanceId: string; keyId: string };
        };
        binding = {
          version: "kab.installation-binding.v1",
          tenantId: "tenant-production",
          installationId: "installation-production",
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
        return json({ binding });
      }

      case "/api/products/agent-bridge/session/challenge":
        return json({
          version: "kab.session-challenge.v1",
          nonce: "session-nonce",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });

      case "/api/products/agent-bridge/session/open": {
        assert.ok(binding);
        return json({
          credential: {
            version: "kab.session-credential.v1",
            sessionId: "session-production",
            tenantId: binding.tenantId,
            installationId: binding.installationId,
            bridgeInstanceId: binding.bridgeInstanceId,
            keyId: binding.keyId,
            accessToken: "session-secret-must-never-persist",
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
        commandPulls += 1;
        if (commandPulls > 2) {
          return json({
            batch: {
              version: "kab.command-batch.v1",
              batchId: `batch-${commandPulls}`,
              sessionId: "session-production",
              commands: [],
            },
          });
        }

        const now = Date.now();
        const commandInput = { value: "approved-write" };
        const correlationId = "corr-production-secure";
        const actionFingerprint = createActionFingerprint({
          tenantId: binding.tenantId,
          installationId: binding.installationId,
          toolId: TOOL_ID,
          correlationId,
          input: commandInput,
        });
        const token = approvalToken({
          version: "kab.approval.v1",
          decision: "ALLOW",
          tenantId: binding.tenantId,
          installationId: binding.installationId,
          toolId: TOOL_ID,
          correlationId,
          actionFingerprint,
          issuedAt: new Date(now - 10_000).toISOString(),
          expiresAt: new Date(now + 120_000).toISOString(),
          nonce: "production-single-use-nonce",
        });

        return json({
          batch: {
            version: "kab.command-batch.v1",
            batchId: `batch-${commandPulls}`,
            sessionId: "session-production",
            commands: [
              {
                version: "kab.command.v1",
                commandId: `command-${commandPulls}`,
                deliveryAttempt: 1,
                tenantId: binding.tenantId,
                installationId: binding.installationId,
                bridgeInstanceId: binding.bridgeInstanceId,
                correlationId,
                actor: "agent-production",
                toolId: TOOL_ID,
                input: commandInput,
                actionFingerprint,
                approvalToken: token,
                issuedAt: new Date(now - 5_000).toISOString(),
                expiresAt: new Date(now + 120_000).toISOString(),
              },
            ],
          },
        });
      }

      case "/api/products/agent-bridge/commands/ack": {
        const acknowledgement = body.acknowledgement as Record<string, unknown>;
        commandAcks.push(acknowledgement);
        maybeComplete();
        return new Response(null, { status: 204 });
      }

      case "/api/products/agent-bridge/audit/batch": {
        const batch = body.batch as {
          batchId: string;
          events: Array<Record<string, unknown>>;
        };
        deliveredAuditEvents.push(...batch.events);
        maybeComplete();
        return json({
          ack: {
            version: "kab.audit-batch-ack.v1",
            batchId: batch.batchId,
            acceptedEventIds: batch.events.map((event) => event.eventId),
          },
        });
      }

      default:
        return json({ code: "unexpected_test_endpoint" }, 404);
    }
  }) as typeof globalThis.fetch;

  function maybeComplete(): void {
    const replayDenied = commandAcks.some((ack) => ack.status === "denied");
    const denialAudited = deliveredAuditEvents.some(
      (event) => event.outcome === "DENY",
    );
    if (commandAcks.length >= 2 && replayDenied && denialAudited) {
      completeTest?.();
    }
  }

  try {
    const runtime = new ProductionRuntime({
      platformBaseUrl: "https://platform.example",
      stateDir,
      runtimeVersion: "0.1.0-test",
      deploymentMode: "local",
      connectorInstances: [connector],
      fetch: fakeFetch,
    });

    await runtime.enroll("one-time-enrollment-token");
    const running = runtime.run(controller.signal);

    await Promise.race([
      completed,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("Secure production pipeline acceptance timed out.")), 8_000),
      ),
    ]);

    controller.abort();
    await running;

    assert.equal(writeExecutions, 1);
    assert.equal(commandAcks[0]?.status, "executed");
    assert.equal(commandAcks[1]?.status, "denied");

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

    assert.match(replayState, /production-single-use-nonce/);
    assert.match(receiptState, /"outcome": "executed"/);
    assert.match(receiptState, /"outcome": "denied"/);
    assert.doesNotMatch(persistedState, /session-secret-must-never-persist/);
    assert.doesNotMatch(persistedState, /kab1\./);
    assert.deepEqual(JSON.parse(auditState), {
      version: "kab.audit-outbox.v1",
      events: [],
    });
  } finally {
    controller.abort();
    await rm(stateDir, { recursive: true, force: true });
  }
});

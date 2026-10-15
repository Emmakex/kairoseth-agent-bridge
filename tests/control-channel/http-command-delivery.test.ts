import assert from "node:assert/strict";
import test from "node:test";

import {
  BridgeRuntime,
  CommandDeliveryScheduler,
  CommandProcessor,
  ControlSession,
  HttpCommandTransport,
  InMemoryCommandReceiptStore,
  ToolRegistry,
  createActionFingerprint,
  type CommandAcknowledgement,
  type CommandBatch,
  type CommandEnvelope,
  type OutboundCommandTransport,
  type OutboundSessionTransport,
  type SessionCredential,
} from "../../src/index.js";

const credential: SessionCredential = {
  version: "kab.session-credential.v1",
  sessionId: "session-1",
  tenantId: "tenant-1",
  installationId: "installation-1",
  bridgeInstanceId: "bridge-1",
  keyId: "key-1",
  accessToken: "access-secret",
  issuedAt: "2026-10-15T04:00:00.000Z",
  expiresAt: "2099-10-15T05:00:00.000Z",
  heartbeatIntervalSeconds: 30,
};

const unusedSessionTransport: OutboundSessionTransport = {
  async requestSessionChallenge() {
    throw new Error("unused");
  },
  async openSession() {
    throw new Error("unused");
  },
  async sendHeartbeat() {
    throw new Error("unused");
  },
};

function session(): ControlSession {
  return new ControlSession(credential, unusedSessionTransport, {
    runtimeVersion: "1.2.3",
  });
}

test("HTTP command transport uses bearer auth and bounded pull contract", async () => {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const transport = new HttpCommandTransport({
    baseUrl: "https://kairoseth.example",
    fetch: async (input, init) => {
      requests.push({ url: String(input), init });
      return new Response(
        JSON.stringify({
          batch: {
            version: "kab.command-batch.v1",
            batchId: "batch-1",
            sessionId: "session-1",
            commands: [],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });

  const batch = await transport.fetchCommands("secret-token", "session-1", 10);
  assert.equal(batch.batchId, "batch-1");
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0]?.url,
    "https://kairoseth.example/api/products/agent-bridge/commands/pull",
  );
  assert.equal(
    new Headers(requests[0]?.init?.headers).get("authorization"),
    "Bearer secret-token",
  );
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
    sessionId: "session-1",
    limit: 10,
  });
});

test("HTTP command transport rejects insecure remote origins and invalid batches", async () => {
  assert.throws(
    () => new HttpCommandTransport({ baseUrl: "http://platform.example" }),
    /requires HTTPS outside local development/,
  );

  const transport = new HttpCommandTransport({
    baseUrl: "https://kairoseth.example",
    fetch: async () =>
      new Response(JSON.stringify({ batch: { version: "wrong" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });

  await assert.rejects(
    () => transport.fetchCommands("token", "session-1", 10),
    /invalid command batch/i,
  );
});

test("command scheduler does not poll before a control session exists", async () => {
  const processor = new CommandProcessor(
    new BridgeRuntime(),
    new InMemoryCommandReceiptStore(),
  );
  let pulls = 0;
  const transport: OutboundCommandTransport = {
    async fetchCommands() {
      pulls += 1;
      throw new Error("must not pull");
    },
    async acknowledgeCommand() {
      throw new Error("must not acknowledge");
    },
  };

  const scheduler = new CommandDeliveryScheduler(
    { getCurrentSession: () => null },
    transport,
    processor,
  );

  assert.deepEqual(await scheduler.tick(), {
    polled: false,
    reason: "no_session",
    acknowledgements: 0,
  });
  assert.equal(pulls, 0);
});

test("redelivered command is acknowledged as duplicate without a second side effect", async () => {
  const registry = new ToolRegistry();
  let executions = 0;
  registry.register({
    id: "demo.read",
    name: "Demo read",
    description: "Read a demo value",
    risk: "READ",
    async execute() {
      executions += 1;
      return { value: 42 };
    },
  });

  const runtime = new BridgeRuntime({ registry });
  const processor = new CommandProcessor(
    runtime,
    new InMemoryCommandReceiptStore(),
    { now: () => new Date("2026-10-15T04:10:00.000Z") },
  );

  const command = createCommand();
  const acknowledgements: CommandAcknowledgement[] = [];
  const transport: OutboundCommandTransport = {
    async fetchCommands(_token, sessionId): Promise<CommandBatch> {
      return {
        version: "kab.command-batch.v1",
        batchId: `batch-${acknowledgements.length + 1}`,
        sessionId,
        commands: [command],
      };
    },
    async acknowledgeCommand(_token, acknowledgement) {
      acknowledgements.push(acknowledgement);
    },
  };

  const activeSession = session();
  const scheduler = new CommandDeliveryScheduler(
    { getCurrentSession: () => activeSession },
    transport,
    processor,
  );

  const first = await scheduler.tick();
  const second = await scheduler.tick();

  assert.equal(first.polled, true);
  assert.equal(second.polled, true);
  assert.equal(executions, 1);
  assert.equal(acknowledgements[0]?.status, "executed");
  assert.equal(acknowledgements[1]?.status, "duplicate");
  assert.equal(acknowledgements[1]?.originalOutcome, "executed");
});

function createCommand(): CommandEnvelope {
  const input = { id: "demo-1" };
  const actionFingerprint = createActionFingerprint({
    tenantId: credential.tenantId,
    installationId: credential.installationId,
    toolId: "demo.read",
    correlationId: "corr-1",
    input,
  });

  return {
    version: "kab.command.v1",
    commandId: "cmd-1",
    deliveryAttempt: 1,
    tenantId: credential.tenantId,
    installationId: credential.installationId,
    bridgeInstanceId: credential.bridgeInstanceId,
    correlationId: "corr-1",
    actor: "agent-1",
    toolId: "demo.read",
    input,
    actionFingerprint,
    issuedAt: "2026-10-15T04:09:00.000Z",
    expiresAt: "2026-10-15T04:30:00.000Z",
  };
}

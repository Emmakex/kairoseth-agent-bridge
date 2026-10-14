import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentCard,
  SendMessageRequest,
  TaskState,
} from "@a2a-js/sdk";
import {
  Client,
  JsonRpcTransportFactory,
} from "@a2a-js/sdk/client";

import {
  A2AAgentCardAdapter,
  A2AIdentityMapper,
  A2AToolExecutionAdapter,
  BridgeRuntime,
  KAIROSETH_A2A_TOOL_INVOCATION_EXTENSION_URI,
  MemoryAuditSink,
  ToolRegistry,
  type A2AExecutionContext,
  type A2ASendMessageRequest,
  type ToolDefinition,
} from "../../src/index.js";

const ENDPOINT = "https://bridge.example.com/a2a/jsonrpc";

function localizedTool(
  id: string,
  risk: "READ" | "WRITE",
  execute: ToolDefinition["execute"],
): ToolDefinition {
  return {
    id,
    name: id,
    description: id,
    localizations: {
      es: {
        name: `ES ${id}`,
        description: `Descripción ES ${id}`,
      },
      en: {
        name: `EN ${id}`,
        description: `EN description ${id}`,
      },
    },
    risk,
    inputSchema: { type: "object", additionalProperties: true },
    outputSchema: { type: "object", additionalProperties: true },
    execute,
  };
}

function createCard(registry: ToolRegistry): AgentCard {
  const card = new A2AAgentCardAdapter(registry, {
    version: "0.1.0-dev.0",
    localizations: {
      es: {
        name: "Kairoseth Agent Bridge",
        description: "Gateway de agentes Kairoseth.",
      },
      en: {
        name: "Kairoseth Agent Bridge",
        description: "Kairoseth agent gateway.",
      },
    },
    supportedInterfaces: [
      {
        url: ENDPOINT,
        protocolBinding: "JSONRPC",
        protocolVersion: "1.0",
      },
    ],
    extensions: {
      es: [
        {
          uri: KAIROSETH_A2A_TOOL_INVOCATION_EXTENSION_URI,
          description: "Invocación estructurada y segura de herramientas Kairoseth.",
          required: true,
          params: { envelope: "kairoseth.tool-invocation.v1" },
        },
      ],
      en: [
        {
          uri: KAIROSETH_A2A_TOOL_INVOCATION_EXTENSION_URI,
          description: "Structured and secure invocation of Kairoseth tools.",
          required: true,
          params: { envelope: "kairoseth.tool-invocation.v1" },
        },
      ],
    },
  }).getAgentCard("en");

  // Parsing through the official SDK is part of this interoperability test:
  // our discovery card must be valid A2A v1 ProtoJSON, not merely our own type.
  return AgentCard.fromJSON(card);
}

function sdkRequest(toolId: string, input: unknown, messageId: string) {
  return SendMessageRequest.fromJSON({
    message: {
      messageId,
      role: "ROLE_USER",
      parts: [
        {
          data: {
            version: "kairoseth.tool-invocation.v1",
            toolId,
            input,
          },
          mediaType: "application/json",
        },
      ],
      extensions: [KAIROSETH_A2A_TOOL_INVOCATION_EXTENSION_URI],
    },
    configuration: {
      acceptedOutputModes: ["application/json"],
    },
  });
}

function activatedExtensions(headers: Headers): string[] {
  const value = headers.get("A2A-Extensions");
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

async function mappedContext(
  mapper: A2AIdentityMapper,
  headers: Headers,
  correlationId: string,
): Promise<A2AExecutionContext> {
  const mapped = await mapper.map({
    principal: {
      issuer: "https://trusted-agent.example.com",
      subject: "official-sdk-client",
      authenticationMethod: "oauth2",
      clientId: "a2a-sdk-interop",
      scopes: ["bridge.invoke"],
    },
    correlationId,
    activatedExtensions: activatedExtensions(headers),
    locale: "en",
  });
  if (!mapped.mapped) {
    throw new Error(`A2A identity mapping failed: ${mapped.reason}`);
  }
  return mapped.context;
}

function createOfficialSdkFetch(options: {
  adapter: A2AToolExecutionAdapter;
  mapper: A2AIdentityMapper;
  seenHeaders: Headers[];
}): typeof fetch {
  return async (_input, init) => {
    const headers = new Headers(init?.headers);
    options.seenHeaders.push(headers);

    assert.equal(headers.get("A2A-Version"), "1.0");
    assert.equal(
      headers.get("A2A-Extensions"),
      KAIROSETH_A2A_TOOL_INVOCATION_EXTENSION_URI,
    );
    assert.match(headers.get("Content-Type") ?? "", /application\/json/i);

    if (typeof init?.body !== "string") {
      return new Response("Missing JSON-RPC body", { status: 400 });
    }

    const rpc = JSON.parse(init.body) as {
      jsonrpc?: unknown;
      id?: unknown;
      method?: unknown;
      params?: unknown;
    };
    assert.equal(rpc.jsonrpc, "2.0");
    assert.equal(typeof rpc.id === "number" || typeof rpc.id === "string", true);

    if (rpc.method !== "SendMessage") {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: rpc.id,
          error: { code: -32601, message: "Method not found" },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const context = await mappedContext(
      options.mapper,
      headers,
      `sdk-${String(rpc.id)}`,
    );
    const result = await options.adapter.sendMessage(
      rpc.params as A2ASendMessageRequest,
      context,
    );

    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: rpc.id,
        result,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  };
}

test("official @a2a-js/sdk 1.3.0 JSON-RPC client interoperates with Kairoseth READ execution", async () => {
  const registry = new ToolRegistry();
  const audit = new MemoryAuditSink();
  let seenActor: string | undefined;
  let seenProtocol: string | undefined;
  registry.register(
    localizedTool("demo.sdk.read", "READ", async (_input, context) => {
      seenActor = context.actor;
      seenProtocol = context.provenance?.protocol;
      return { ok: true, source: "kairoseth" };
    }),
  );

  const adapter = new A2AToolExecutionAdapter(
    new BridgeRuntime({ registry, audit }),
  );
  const mapper = new A2AIdentityMapper(async () => ({
    actor: "agent:official-sdk",
    tenantId: "tenant-1",
    installationId: "installation-1",
    delegationRequired: false,
  }));
  const seenHeaders: Headers[] = [];
  const fetchImpl = createOfficialSdkFetch({ adapter, mapper, seenHeaders });

  const card = createCard(registry);
  const transport = await new JsonRpcTransportFactory({ fetchImpl }).create(
    ENDPOINT,
    card,
  );
  const client = new Client(transport, card);

  const result = await client.sendMessage(
    sdkRequest("demo.sdk.read", { id: 42 }, "sdk-read-1"),
    {
      serviceParameters: {
        "A2A-Extensions": KAIROSETH_A2A_TOOL_INVOCATION_EXTENSION_URI,
      },
    },
  );

  assert.ok("status" in result);
  assert.equal(result.status?.state, TaskState.TASK_STATE_COMPLETED);
  assert.equal(result.artifacts?.[0]?.parts[0]?.content?.$case, "data");
  assert.deepEqual(result.artifacts?.[0]?.parts[0]?.content?.value, {
    ok: true,
    source: "kairoseth",
  });
  assert.equal(seenActor, "agent:official-sdk");
  assert.equal(seenProtocol, "a2a");
  assert.equal(seenHeaders.length, 1);
  assert.deepEqual(
    audit.all().map((event) => event.type),
    [
      "INVOCATION_RECEIVED",
      "POLICY_EVALUATED",
      "EXECUTION_STARTED",
      "EXECUTION_SUCCEEDED",
    ],
  );
});

test("official SDK WRITE request still stops at Kairoseth approval gate", async () => {
  const registry = new ToolRegistry();
  let executions = 0;
  registry.register(
    localizedTool("demo.sdk.write", "WRITE", async () => {
      executions += 1;
      return { ok: true };
    }),
  );

  const adapter = new A2AToolExecutionAdapter(new BridgeRuntime({ registry }));
  const mapper = new A2AIdentityMapper(async () => ({
    actor: "agent:official-sdk",
    tenantId: "tenant-1",
    installationId: "installation-1",
    delegationRequired: false,
  }));
  const seenHeaders: Headers[] = [];
  const card = createCard(registry);
  const transport = await new JsonRpcTransportFactory({
    fetchImpl: createOfficialSdkFetch({ adapter, mapper, seenHeaders }),
  }).create(ENDPOINT, card);
  const client = new Client(transport, card);

  const result = await client.sendMessage(
    sdkRequest("demo.sdk.write", { enabled: true }, "sdk-write-1"),
    {
      serviceParameters: {
        "A2A-Extensions": KAIROSETH_A2A_TOOL_INVOCATION_EXTENSION_URI,
      },
    },
  );

  assert.ok("status" in result);
  assert.equal(result.status?.state, TaskState.TASK_STATE_AUTH_REQUIRED);
  assert.equal(executions, 0);
  assert.equal(seenHeaders.length, 1);
});

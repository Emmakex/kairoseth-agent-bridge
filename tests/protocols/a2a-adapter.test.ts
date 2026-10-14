import assert from "node:assert/strict";
import test from "node:test";

import {
  A2AAgentCardAdapter,
  ToolRegistry,
  type ToolDefinition,
} from "../../src/index.js";

function tool(
  id: string,
  risk: "READ" | "WRITE" | "CRITICAL",
): ToolDefinition {
  return {
    id,
    name: `Canonical ${id}`,
    description: `Canonical description for ${id}`,
    localizations: {
      en: {
        name: `English ${id}`,
        description: `English description for ${id}`,
      },
      es: {
        name: `Español ${id}`,
        description: `Descripción en español para ${id}`,
      },
    },
    risk,
    inputSchema: { type: "object", additionalProperties: false },
    outputSchema: { type: "object", additionalProperties: true },
    async execute() {
      return { ok: true };
    },
  };
}

function options() {
  return {
    version: "0.1.0-dev.0",
    localizations: {
      en: {
        name: "Kairoseth Agent Bridge",
        description: "Secure A2A access to normalized business tools.",
      },
      es: {
        name: "Kairoseth Agent Bridge",
        description: "Acceso A2A seguro a herramientas de negocio normalizadas.",
      },
    },
    supportedInterfaces: [
      {
        url: "https://bridge.example.com/a2a/v1",
        protocolBinding: "HTTP+JSON",
        protocolVersion: "1.0" as const,
      },
      {
        url: "https://bridge.example.com/a2a/jsonrpc",
        protocolBinding: "JSONRPC",
        protocolVersion: "1.0" as const,
      },
    ],
    provider: {
      url: "https://kairoseth.com",
      organization: "Kairoseth",
    },
    documentationUrl: "https://kairoseth.com/docs/agent-bridge/a2a",
    securitySchemes: {
      bearer: {
        httpAuthSecurityScheme: {
          scheme: "Bearer",
          bearerFormat: "JWT",
        },
      },
    },
    securityRequirements: [{ bearer: [] }],
  };
}

test("A2A Agent Card maps ToolRegistry to deterministic A2A 1.0 skills", () => {
  const registry = new ToolRegistry();
  registry.register(tool("woocommerce.store.orders.get", "READ"));
  registry.register(tool("files.local.docs.delete", "CRITICAL"));
  registry.register(tool("mysql.primary.users.update", "WRITE"));

  const adapter = new A2AAgentCardAdapter(registry, options());
  const card = adapter.getAgentCard("en");

  assert.equal(card.name, "Kairoseth Agent Bridge");
  assert.equal(card.version, "0.1.0-dev.0");
  assert.deepEqual(card.capabilities, {
    streaming: false,
    pushNotifications: false,
    extendedAgentCard: false,
  });
  assert.deepEqual(card.defaultInputModes, ["application/json"]);
  assert.deepEqual(card.defaultOutputModes, ["application/json"]);
  assert.deepEqual(
    card.skills.map((skill) => skill.id),
    [
      "files.local.docs.delete",
      "mysql.primary.users.update",
      "woocommerce.store.orders.get",
    ],
  );

  const read = card.skills.find(
    (skill) => skill.id === "woocommerce.store.orders.get",
  );
  const critical = card.skills.find(
    (skill) => skill.id === "files.local.docs.delete",
  );
  assert.deepEqual(read?.tags, ["kairoseth", "read", "tool", "woocommerce"]);
  assert.deepEqual(critical?.tags, ["critical", "files", "kairoseth", "tool"]);
  assert.deepEqual(read?.inputModes, ["application/json"]);
  assert.deepEqual(read?.outputModes, ["application/json"]);
});

test("A2A Agent Card localizes agent and skills without changing technical IDs", () => {
  const registry = new ToolRegistry();
  registry.register(tool("prestashop.shop.products.get", "READ"));
  const adapter = new A2AAgentCardAdapter(registry, options());

  const es = adapter.getAgentCard("es");
  const en = adapter.getAgentCard("en");

  assert.match(es.description, /Acceso A2A seguro/i);
  assert.match(en.description, /Secure A2A access/i);
  assert.deepEqual(
    es.skills.map((skill) => skill.id),
    en.skills.map((skill) => skill.id),
  );
  assert.equal(
    es.skills[0]?.name,
    "Español prestashop.shop.products.get",
  );
  assert.equal(
    en.skills[0]?.name,
    "English prestashop.shop.products.get",
  );
  assert.match(es.skills[0]?.description ?? "", /Descripción en español/);
  assert.match(en.skills[0]?.description ?? "", /English description/);
});

test("A2A security metadata comes only from trusted Agent Card configuration", () => {
  const registry = new ToolRegistry();
  registry.register(tool("orders.read", "READ"));
  registry.register(tool("orders.write", "WRITE"));
  registry.register(tool("orders.delete", "CRITICAL"));

  const card = new A2AAgentCardAdapter(registry, options()).getAgentCard("en");

  assert.deepEqual(card.securityRequirements, [{ bearer: [] }]);
  assert.deepEqual(card.securitySchemes, {
    bearer: {
      httpAuthSecurityScheme: {
        scheme: "Bearer",
        bearerFormat: "JWT",
      },
    },
  });
  assert.ok(card.skills.every((skill) => skill.securityRequirements === undefined));
  assert.equal(
    card.skills.find((skill) => skill.id === "orders.write")?.tags.includes("write"),
    true,
  );
  assert.equal(
    card.skills.find((skill) => skill.id === "orders.delete")?.tags.includes("critical"),
    true,
  );
});

test("A2A skill publication requires ES and EN localization", () => {
  const registry = new ToolRegistry();
  registry.register({
    ...tool("legacy.only-en", "READ"),
    localizations: {
      en: {
        name: "English only",
        description: "This tool intentionally lacks Spanish for the test.",
      },
    },
  });

  const adapter = new A2AAgentCardAdapter(registry, options());
  assert.throws(
    () => adapter.getAgentCard("en"),
    /requires ES and EN localized name\/description/i,
  );
});

test("A2A interface order is preserved because the first interface is preferred", () => {
  const registry = new ToolRegistry();
  registry.register(tool("demo.read", "READ"));
  const adapter = new A2AAgentCardAdapter(registry, options());

  const card = adapter.getAgentCard("en");
  assert.equal(card.supportedInterfaces[0]?.protocolBinding, "HTTP+JSON");
  assert.equal(card.supportedInterfaces[1]?.protocolBinding, "JSONRPC");
});

test("A2A discovery rejects insecure or malformed interface declarations by default", () => {
  const registry = new ToolRegistry();
  registry.register(tool("demo.read", "READ"));

  assert.throws(
    () =>
      new A2AAgentCardAdapter(registry, {
        ...options(),
        supportedInterfaces: [
          {
            url: "http://localhost:8080/a2a",
            protocolBinding: "HTTP+JSON",
            protocolVersion: "1.0",
          },
        ],
      }),
    /must use HTTPS/i,
  );

  assert.doesNotThrow(
    () =>
      new A2AAgentCardAdapter(registry, {
        ...options(),
        allowInsecureHttp: true,
        supportedInterfaces: [
          {
            url: "http://localhost:8080/a2a",
            protocolBinding: "HTTP+JSON",
            protocolVersion: "1.0",
          },
        ],
      }),
  );

  assert.throws(
    () =>
      new A2AAgentCardAdapter(registry, {
        ...options(),
        supportedInterfaces: [
          {
            url: "https://bridge.example.com/a2a",
            protocolBinding: "HTTP+JSON",
            protocolVersion: "0.3" as "1.0",
          },
        ],
      }),
    /protocolVersion 1\.0 only/i,
  );
});

test("A2A discovery validates host security references and media types", () => {
  const registry = new ToolRegistry();
  registry.register(tool("demo.read", "READ"));

  assert.throws(
    () =>
      new A2AAgentCardAdapter(registry, {
        ...options(),
        securityRequirements: [{ missing: [] }],
      }),
    /unknown scheme: missing/i,
  );

  assert.throws(
    () =>
      new A2AAgentCardAdapter(registry, {
        ...options(),
        defaultInputModes: ["not a media type"],
      }),
    /invalid media type/i,
  );
});

test("getSkill returns localized skill or null and Agent Card snapshots are isolated", () => {
  const registry = new ToolRegistry();
  registry.register(tool("demo.read", "READ"));
  const adapter = new A2AAgentCardAdapter(registry, options());

  assert.equal(adapter.getSkill("demo.read", "es")?.name, "Español demo.read");
  assert.equal(adapter.getSkill("missing", "en"), null);

  const first = adapter.getAgentCard("en");
  (first.supportedInterfaces as A2AAgentCardAdapter["getAgentCard"] extends (...args: never[]) => infer R ? R["supportedInterfaces"] : never);
  const mutable = first.supportedInterfaces as Array<{ url: string }>;
  mutable[0]!.url = "https://tampered.example.com";
  const second = adapter.getAgentCard("en");
  assert.equal(
    second.supportedInterfaces[0]?.url,
    "https://bridge.example.com/a2a/v1",
  );
});

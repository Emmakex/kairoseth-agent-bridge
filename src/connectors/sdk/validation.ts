import type {
  ConnectorCredentialRequirement,
  ConnectorDefinition,
  ConnectorManifest,
  ConnectorToolDefinition,
  JsonSchema,
} from "./contracts.js";

const ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const SEMVERISH_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function validateConnectorDefinition(connector: ConnectorDefinition): void {
  validateConnectorManifest(connector.manifest);

  if (!Array.isArray(connector.tools) || connector.tools.length === 0) {
    throw new Error("Connector must declare at least one tool.");
  }

  const toolIds = new Set<string>();

  for (const tool of connector.tools) {
    validateConnectorTool(tool);

    if (toolIds.has(tool.id)) {
      throw new Error(`Connector declares duplicate tool ID: ${tool.id}`);
    }

    toolIds.add(tool.id);
  }
}

export function validateConnectorManifest(manifest: ConnectorManifest): void {
  validateId(manifest.id, "connector ID");
  requireText(manifest.name, "Connector name");
  requireText(manifest.description, "Connector description");

  if (!SEMVERISH_PATTERN.test(manifest.version)) {
    throw new Error("Connector version must use semantic-version form.");
  }

  if (manifest.configSchema) {
    validateJsonSchema(manifest.configSchema, "config schema");
  }

  const capabilities = new Set<string>();
  for (const capability of manifest.capabilities) {
    validateId(capability, "connector capability");
    if (capabilities.has(capability)) {
      throw new Error(`Connector declares duplicate capability: ${capability}`);
    }
    capabilities.add(capability);
  }

  const requirements = new Set<string>();
  for (const requirement of manifest.credentials) {
    validateCredentialRequirement(requirement);
    if (requirements.has(requirement.id)) {
      throw new Error(`Connector declares duplicate credential requirement: ${requirement.id}`);
    }
    requirements.add(requirement.id);
  }
}

export function validateConnectorTool(tool: ConnectorToolDefinition): void {
  validateId(tool.id, "connector tool ID");
  requireText(tool.name, "Connector tool name");
  requireText(tool.description, "Connector tool description");
  validateJsonSchema(tool.inputSchema, "input schema");

  if (tool.outputSchema) {
    validateJsonSchema(tool.outputSchema, "output schema");
  }

  const timeoutMs = tool.behavior?.timeoutMs;
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300_000)) {
    throw new Error(`Connector tool ${tool.id} timeout must be between 100 and 300000 ms.`);
  }

  const retry = tool.behavior?.retry;
  const idempotency = tool.behavior?.idempotency ?? { mode: "none" as const };

  if (idempotency.mode === "keyed" && !idempotency.keyField?.trim()) {
    throw new Error(`Connector tool ${tool.id} keyed idempotency requires keyField.`);
  }

  if (idempotency.mode !== "keyed" && idempotency.keyField !== undefined) {
    throw new Error(`Connector tool ${tool.id} keyField is only valid for keyed idempotency.`);
  }

  if (retry?.mode === "transient") {
    const maxAttempts = retry.maxAttempts ?? 3;
    const baseDelayMs = retry.baseDelayMs ?? 250;
    const maxDelayMs = retry.maxDelayMs ?? 5_000;

    if (!Number.isInteger(maxAttempts) || maxAttempts < 2 || maxAttempts > 10) {
      throw new Error(`Connector tool ${tool.id} retry maxAttempts must be between 2 and 10.`);
    }

    if (!Number.isInteger(baseDelayMs) || baseDelayMs < 10 || baseDelayMs > 60_000) {
      throw new Error(`Connector tool ${tool.id} retry baseDelayMs is invalid.`);
    }

    if (!Number.isInteger(maxDelayMs) || maxDelayMs < baseDelayMs || maxDelayMs > 300_000) {
      throw new Error(`Connector tool ${tool.id} retry maxDelayMs is invalid.`);
    }

    if (tool.risk !== "READ" && idempotency.mode === "none") {
      throw new Error(
        `Connector tool ${tool.id} cannot enable automatic transient retries for ${tool.risk} without idempotency.`,
      );
    }
  }
}

export function connectorRuntimeToolId(
  connectorId: string,
  instanceId: string,
  toolId: string,
): string {
  validateId(connectorId, "connector ID");
  validateId(instanceId, "connector instance ID");
  validateId(toolId, "connector tool ID");
  return `${connectorId}.${instanceId}.${toolId}`;
}

function validateCredentialRequirement(requirement: ConnectorCredentialRequirement): void {
  validateId(requirement.id, "credential requirement ID");
  requireText(requirement.label, "Credential requirement label");

  if (requirement.fields.length === 0) {
    throw new Error(`Credential requirement ${requirement.id} must declare at least one field.`);
  }

  const fieldIds = new Set<string>();
  for (const field of requirement.fields) {
    validateId(field.id, "credential field ID");
    requireText(field.label, "Credential field label");

    if (fieldIds.has(field.id)) {
      throw new Error(`Credential requirement ${requirement.id} has duplicate field: ${field.id}`);
    }
    fieldIds.add(field.id);
  }
}

function validateJsonSchema(schema: JsonSchema, label: string): void {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new Error(`Connector ${label} must be an object.`);
  }

  if (schema.required && schema.properties) {
    for (const required of schema.required) {
      if (!(required in schema.properties)) {
        throw new Error(`Connector ${label} requires unknown property: ${required}`);
      }
    }
  }

  if (schema.properties) {
    for (const [property, child] of Object.entries(schema.properties)) {
      if (!property) {
        throw new Error(`Connector ${label} contains an empty property name.`);
      }
      validateJsonSchema(child, `${label}.${property}`);
    }
  }

  if (schema.oneOf) {
    for (const child of schema.oneOf) validateJsonSchema(child, `${label}.oneOf`);
  }
  if (schema.anyOf) {
    for (const child of schema.anyOf) validateJsonSchema(child, `${label}.anyOf`);
  }
  if (schema.allOf) {
    for (const child of schema.allOf) validateJsonSchema(child, `${label}.allOf`);
  }

  if (schema.items && !Array.isArray(schema.items)) {
    validateJsonSchema(schema.items, `${label}.items`);
  } else if (Array.isArray(schema.items)) {
    for (const child of schema.items) validateJsonSchema(child, `${label}.items`);
  }
}

function validateId(value: string, label: string): void {
  if (!ID_PATTERN.test(value)) {
    throw new Error(`${label} must match ${ID_PATTERN.source}.`);
  }
}

function requireText(value: string, label: string): void {
  if (!value.trim()) {
    throw new Error(`${label} is required.`);
  }
}

import type {
  ConnectorCredentialRequirement,
  ConnectorDefinition,
  ConnectorToolDefinition,
  JsonSchema,
} from "../sdk/contracts.js";
import { validateConnectorDefinition } from "../sdk/validation.js";
import type {
  GenericRestAuth,
  GenericRestConnectorOptions,
  GenericRestEndpointDefinition,
  GenericRestToolOutput,
} from "./contracts.js";
import {
  executeGenericRestEndpoint,
  validateGenericRestConnectorOptions,
} from "./http.js";

const DEFAULT_AUTH: GenericRestAuth = { type: "none" };

export function createGenericRestConnector(
  options: GenericRestConnectorOptions,
): ConnectorDefinition {
  validateGenericRestConnectorOptions(options);

  const defaultAuth = options.auth ?? DEFAULT_AUTH;
  const credentials = collectCredentialRequirements(options, defaultAuth);
  const tools: ConnectorToolDefinition[] = options.endpoints.map((endpoint) =>
    endpointToTool(options, endpoint, defaultAuth),
  );

  const connector: ConnectorDefinition = {
    manifest: {
      id: options.id ?? "generic-rest",
      name: options.name ?? "Generic REST",
      version: options.version ?? "1.0.0",
      description:
        options.description ??
        "Declarative REST API connector for Kairoseth Agent Bridge.",
      capabilities: capabilityList(options.endpoints),
      configSchema: {
        type: "object",
        properties: {
          baseUrl: {
            type: "string",
            format: "uri",
            description:
              "Fixed API origin for this connector instance. It is not tool input.",
          },
        },
        required: ["baseUrl"],
        additionalProperties: false,
      },
      credentials,
    },
    tools,
  };

  validateConnectorDefinition(connector);
  return connector;
}

function endpointToTool(
  connectorOptions: GenericRestConnectorOptions,
  endpoint: GenericRestEndpointDefinition,
  defaultAuth: GenericRestAuth,
): ConnectorToolDefinition {
  const outputSchema = genericRestOutputSchema(endpoint.outputSchema);

  return {
    id: endpoint.id,
    name: endpoint.name,
    description: endpoint.description,
    risk: endpoint.risk,
    inputSchema: endpoint.inputSchema,
    outputSchema,
    behavior: endpoint.behavior,
    async execute(input, context): Promise<GenericRestToolOutput> {
      return executeGenericRestEndpoint(
        {
          connectorOptions,
          endpoint,
          defaultAuth,
        },
        input,
        context,
      );
    },
  };
}

function genericRestOutputSchema(bodySchema: JsonSchema | undefined): JsonSchema {
  return {
    type: "object",
    properties: {
      status: {
        type: "integer",
        minimum: 100,
        maximum: 599,
      },
      body: bodySchema ?? {},
    },
    required: ["status", "body"],
    additionalProperties: false,
  };
}

function capabilityList(
  endpoints: readonly GenericRestEndpointDefinition[],
): readonly string[] {
  return [
    ...new Set(
      endpoints.map((endpoint) => `http.${endpoint.method.toLowerCase()}`),
    ),
  ].sort();
}

function collectCredentialRequirements(
  options: GenericRestConnectorOptions,
  defaultAuth: GenericRestAuth,
): readonly ConnectorCredentialRequirement[] {
  const requirements = new Map<string, ConnectorCredentialRequirement>();
  addAuthRequirement(requirements, defaultAuth);

  for (const endpoint of options.endpoints) {
    if (endpoint.auth) {
      addAuthRequirement(requirements, endpoint.auth);
    }
  }

  return [...requirements.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
}

function addAuthRequirement(
  requirements: Map<string, ConnectorCredentialRequirement>,
  auth: GenericRestAuth,
): void {
  const requirement = authRequirement(auth);
  if (!requirement) return;

  const existing = requirements.get(requirement.id);
  if (!existing) {
    requirements.set(requirement.id, requirement);
    return;
  }

  if (JSON.stringify(existing) !== JSON.stringify(requirement)) {
    throw new Error(
      `Generic REST credential requirement ${requirement.id} is declared with conflicting auth mappings.`,
    );
  }
}

function authRequirement(
  auth: GenericRestAuth,
): ConnectorCredentialRequirement | null {
  switch (auth.type) {
    case "none":
      return null;
    case "bearer":
      return {
        id: auth.requirementId,
        kind: "bearer",
        label: "Bearer authentication",
        required: true,
        fields: [
          {
            id: auth.tokenField,
            label: "Bearer token",
            secret: true,
            required: true,
          },
        ],
      };
    case "api_key":
      return {
        id: auth.requirementId,
        kind: "api_key",
        label: "API key authentication",
        required: true,
        fields: [
          {
            id: auth.fieldId,
            label: "API key",
            secret: true,
            required: true,
          },
        ],
      };
    case "basic":
      return {
        id: auth.requirementId,
        kind: "basic",
        label: "HTTP Basic authentication",
        required: true,
        fields: [
          {
            id: auth.usernameField,
            label: "Username",
            secret: false,
            required: true,
          },
          {
            id: auth.passwordField,
            label: "Password",
            secret: true,
            required: true,
          },
        ],
      };
  }
}

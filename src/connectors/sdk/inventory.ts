import type { RiskLevel, ToolLocalizations } from "../../core/contracts.js";
import type { ConnectorInstance } from "./contracts.js";
import {
  connectorRuntimeToolId,
  validateConnectorDefinition,
} from "./validation.js";

export interface ConnectorToolInventorySnapshot {
  toolId: string;
  runtimeToolId: string;
  name: string;
  description: string;
  localizations?: ToolLocalizations | undefined;
  risk: RiskLevel;
}

export interface ConnectorInstanceInventorySnapshot {
  connectorId: string;
  connectorInstanceId: string;
  name: string;
  version: string;
  description: string;
  localizations?: ToolLocalizations | undefined;
  capabilities: readonly string[];
  tools: readonly ConnectorToolInventorySnapshot[];
}

/**
 * Build a deterministic, metadata-only inventory for control-plane reporting.
 *
 * Deliberately excluded:
 * - connector instance config
 * - credential requirements/values
 * - SecretProvider references
 * - execution inputs/outputs
 *
 * The snapshot is descriptive only. It does not grant execution authority.
 */
export function buildConnectorInventory(
  instances: readonly ConnectorInstance[],
): readonly ConnectorInstanceInventorySnapshot[] {
  return [...instances]
    .map((instance) => {
      validateConnectorDefinition(instance.connector);
      const { manifest } = instance.connector;
      const tools = [...instance.connector.tools]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((tool): ConnectorToolInventorySnapshot => ({
          toolId: tool.id,
          runtimeToolId: connectorRuntimeToolId(
            manifest.id,
            instance.instanceId,
            tool.id,
          ),
          name: tool.name,
          description: tool.description,
          ...(tool.localizations ? { localizations: tool.localizations } : {}),
          risk: tool.risk,
        }));

      return {
        connectorId: manifest.id,
        connectorInstanceId: instance.instanceId,
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        ...(manifest.localizations
          ? { localizations: manifest.localizations }
          : {}),
        capabilities: [...new Set(manifest.capabilities)].sort(),
        tools,
      };
    })
    .sort((left, right) => {
      const connectorOrder = left.connectorId.localeCompare(right.connectorId);
      return connectorOrder !== 0
        ? connectorOrder
        : left.connectorInstanceId.localeCompare(right.connectorInstanceId);
    });
}

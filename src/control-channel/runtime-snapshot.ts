import { randomUUID } from "node:crypto";

import type { ConnectorInstance } from "../connectors/sdk/contracts.js";
import type { ConnectorRegistryAdapter } from "../connectors/sdk/registry-adapter.js";
import {
  buildConnectorInventory,
  type ConnectorInstanceInventorySnapshot,
} from "../connectors/sdk/inventory.js";

export interface RuntimeToolHealthSnapshot {
  toolId: string;
  runtimeToolId: string;
  availability: "available" | "degraded" | "blocked";
  blockedReason?: "circuit_open" | "credential_rotation" | undefined;
}

export interface RuntimeConnectorHealthSnapshot {
  connectorId: string;
  connectorInstanceId: string;
  status: "healthy" | "degraded" | "unhealthy";
  checkedAt: string;
  tools: readonly RuntimeToolHealthSnapshot[];
}

export interface RuntimeOperationalSnapshot {
  version: "kab.runtime-snapshot.v1";
  snapshotId: string;
  generatedAt: string;
  connectors: readonly ConnectorInstanceInventorySnapshot[];
  health: readonly RuntimeConnectorHealthSnapshot[];
}

export interface RuntimeSnapshotAck {
  version: "kab.runtime-snapshot-ack.v1";
  snapshotId: string;
  receivedAt: string;
}

export interface RuntimeSnapshotTransport {
  report(
    accessToken: string,
    snapshot: RuntimeOperationalSnapshot,
  ): Promise<RuntimeSnapshotAck>;
}

export interface RuntimeSnapshotReporterOptions {
  now?: (() => Date) | undefined;
  createSnapshotId?: (() => string) | undefined;
}

function instanceKey(connectorId: string, connectorInstanceId: string): string {
  return `${connectorId}\u0000${connectorInstanceId}`;
}

export class RuntimeSnapshotReporter {
  private readonly now: () => Date;
  private readonly createSnapshotId: () => string;

  constructor(
    private readonly instances: readonly ConnectorInstance[],
    private readonly adapter: ConnectorRegistryAdapter,
    private readonly transport: RuntimeSnapshotTransport,
    options: RuntimeSnapshotReporterOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.createSnapshotId = options.createSnapshotId ?? randomUUID;
  }

  async build(): Promise<RuntimeOperationalSnapshot> {
    const connectors = buildConnectorInventory(this.instances);
    const healthSnapshots = await this.adapter.healthRegistered();

    const inventoryKeys = connectors
      .map((item) => instanceKey(item.connectorId, item.connectorInstanceId))
      .sort();
    const healthKeys = healthSnapshots
      .map((item) => instanceKey(item.connectorId, item.connectorInstanceId))
      .sort();

    if (
      inventoryKeys.length !== healthKeys.length ||
      inventoryKeys.some((value, index) => value !== healthKeys[index])
    ) {
      throw new Error(
        "Runtime inventory must exactly match the connector instances registered in the adapter.",
      );
    }

    const health: RuntimeConnectorHealthSnapshot[] = healthSnapshots.map(
      (snapshot) => ({
        connectorId: snapshot.connectorId,
        connectorInstanceId: snapshot.connectorInstanceId,
        status: snapshot.status,
        checkedAt: snapshot.checkedAt,
        tools: snapshot.tools.map((tool) => ({
          toolId: tool.toolId,
          runtimeToolId: tool.runtimeToolId,
          availability: tool.availability,
          ...(tool.blockedReason ? { blockedReason: tool.blockedReason } : {}),
        })),
      }),
    );

    return {
      version: "kab.runtime-snapshot.v1",
      snapshotId: this.createSnapshotId(),
      generatedAt: this.now().toISOString(),
      connectors,
      health,
    };
  }

  async report(accessToken: string): Promise<RuntimeSnapshotAck> {
    if (!accessToken.trim()) {
      throw new Error("Runtime snapshot reporting requires a session access token.");
    }

    const snapshot = await this.build();
    const ack = await this.transport.report(accessToken, snapshot);

    if (ack.version !== "kab.runtime-snapshot-ack.v1") {
      throw new Error("Unsupported runtime snapshot acknowledgement version.");
    }
    if (ack.snapshotId !== snapshot.snapshotId) {
      throw new Error("Runtime snapshot acknowledgement does not match the report.");
    }
    if (!Number.isFinite(Date.parse(ack.receivedAt))) {
      throw new Error("Runtime snapshot acknowledgement timestamp is invalid.");
    }

    return ack;
  }
}

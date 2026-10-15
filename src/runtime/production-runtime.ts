import { join } from "node:path";

import type { ConnectorInstance } from "../connectors/sdk/contracts.js";
import { ConnectorRegistryAdapter } from "../connectors/sdk/registry-adapter.js";
import { ToolRegistry } from "../core/registry.js";
import {
  FileBridgeIdentityStore,
  BridgeIdentityManager,
  toPublicBridgeIdentity,
  type PublicBridgeIdentity,
  type RuntimeDeploymentMode,
} from "../identity/installation-identity.js";
import {
  InstallationEnrollmentClient,
  type InstallationBinding,
} from "../control-channel/enrollment.js";
import { HttpEnrollmentTransport } from "../control-channel/http-enrollment-transport.js";
import {
  FileInstallationBindingStore,
  InstallationBindingManager,
} from "../control-channel/installation-binding.js";
import { HttpRuntimeSnapshotTransport } from "../control-channel/http-runtime-snapshot-transport.js";
import { HttpSessionTransport } from "../control-channel/http-session-transport.js";
import {
  RuntimeSnapshotReporter,
} from "../control-channel/runtime-snapshot.js";
import { RuntimeSnapshotScheduler } from "../control-channel/runtime-snapshot-scheduler.js";
import {
  ControlSessionClient,
  type RuntimeReadiness,
} from "../control-channel/session.js";
import { ControlSessionSupervisor } from "../control-channel/session-supervisor.js";
import { ControlPlaneRuntimeCoordinator } from "./control-plane-runtime-coordinator.js";

export interface ProductionRuntimeOptions {
  platformBaseUrl: string;
  stateDir: string;
  runtimeVersion: string;
  deploymentMode: RuntimeDeploymentMode;
  connectorInstances?: readonly ConnectorInstance[] | undefined;
  allowInsecureHttp?: boolean | undefined;
  onReadinessChange?: ((readiness: RuntimeReadiness) => void) | undefined;
  onRecoverableError?:
    | ((source: "session" | "snapshot", retryDelayMs: number) => void)
    | undefined;
}

export class ProductionRuntime {
  private readonly identityManager: BridgeIdentityManager;
  private readonly bindingStore: FileInstallationBindingStore;
  private readonly bindingManager: InstallationBindingManager;
  private readonly connectorInstances: readonly ConnectorInstance[];
  private readonly connectorAdapter: ConnectorRegistryAdapter;
  private readonly coordinator: ControlPlaneRuntimeCoordinator;
  private readonly enrollmentClient: InstallationEnrollmentClient;

  constructor(private readonly options: ProductionRuntimeOptions) {
    const runtimeVersion = options.runtimeVersion.trim();
    if (!runtimeVersion) {
      throw new Error("Production runtime requires a runtime version.");
    }
    if (!options.stateDir.trim()) {
      throw new Error("Production runtime requires a durable state directory.");
    }

    const identityStore = new FileBridgeIdentityStore(
      join(options.stateDir, "identity", "bridge-identity.json"),
    );
    this.bindingStore = new FileInstallationBindingStore(
      join(options.stateDir, "installation", "binding.json"),
    );
    this.identityManager = new BridgeIdentityManager(identityStore);
    this.bindingManager = new InstallationBindingManager(
      this.bindingStore,
      async () => await this.identityManager.getOrCreate(),
    );

    const registry = new ToolRegistry();
    this.connectorAdapter = new ConnectorRegistryAdapter(registry);
    this.connectorInstances = options.connectorInstances ?? [];
    for (const instance of this.connectorInstances) {
      this.connectorAdapter.register(instance);
    }
    const capabilities = registry.list().map((tool) => tool.id).sort();

    const allowInsecureHttp = options.allowInsecureHttp ?? false;
    const sessionTransport = new HttpSessionTransport({
      baseUrl: options.platformBaseUrl,
      allowInsecureHttp,
    });
    const sessionClient = new ControlSessionClient(
      this.identityManager,
      sessionTransport,
      {
        runtimeVersion,
        capabilities,
      },
    );
    const sessionSupervisor = new ControlSessionSupervisor(
      this.bindingManager,
      sessionClient,
      {
        onError: (_error, retryDelayMs) =>
          options.onRecoverableError?.("session", retryDelayMs),
      },
    );

    const snapshotTransport = new HttpRuntimeSnapshotTransport({
      baseUrl: options.platformBaseUrl,
      allowInsecureHttp,
    });
    const snapshotReporter = new RuntimeSnapshotReporter(
      this.connectorInstances,
      this.connectorAdapter,
      snapshotTransport,
    );
    const snapshotScheduler = new RuntimeSnapshotScheduler(
      sessionSupervisor,
      snapshotReporter,
      {
        onError: (_error, retryDelayMs) =>
          options.onRecoverableError?.("snapshot", retryDelayMs),
      },
    );

    this.coordinator = new ControlPlaneRuntimeCoordinator(
      sessionSupervisor,
      snapshotScheduler,
    );

    const enrollmentTransport = new HttpEnrollmentTransport({
      baseUrl: options.platformBaseUrl,
      allowInsecureHttp,
    });
    this.enrollmentClient = new InstallationEnrollmentClient(
      this.identityManager,
      enrollmentTransport,
      {
        runtimeVersion,
        deploymentMode: options.deploymentMode,
        capabilities,
        bindingStore: this.bindingStore,
      },
    );
  }

  async publicIdentity(): Promise<PublicBridgeIdentity> {
    return toPublicBridgeIdentity(await this.identityManager.getOrCreate());
  }

  async enrollment(): Promise<InstallationBinding | null> {
    return await this.bindingManager.load();
  }

  async enroll(enrollmentToken: string): Promise<InstallationBinding> {
    return await this.enrollmentClient.enroll(enrollmentToken);
  }

  async readiness(): Promise<RuntimeReadiness> {
    const health = await this.connectorAdapter.healthRegistered();
    const degraded = health.some((snapshot) => snapshot.status !== "healthy");
    return degraded ? "degraded" : "ready";
  }

  async run(signal?: AbortSignal): Promise<void> {
    await this.bindingManager.require();

    const initialReadiness = await this.readiness();
    this.options.onReadinessChange?.(initialReadiness);

    await this.coordinator.run(async () => {
      const readiness = await this.readiness();
      this.options.onReadinessChange?.(readiness);
      return readiness;
    }, signal);
  }
}

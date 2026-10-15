import { join } from "node:path";

import { FileAuditOutboxStore } from "../audit/outbox.js";
import { SanitizedAuditSink } from "../audit/sanitized-sink.js";
import type { ConnectorInstance } from "../connectors/sdk/contracts.js";
import { ConnectorRegistryAdapter } from "../connectors/sdk/registry-adapter.js";
import { ApprovalKeySyncScheduler } from "../control-channel/approval-key-sync-scheduler.js";
import { AuditDeliveryScheduler } from "../control-channel/audit-delivery-scheduler.js";
import { CommandDeliveryScheduler } from "../control-channel/command-delivery-scheduler.js";
import { FileCommandReceiptStore } from "../control-channel/command-receipts.js";
import { CommandProcessor } from "../control-channel/command.js";
import {
  InstallationEnrollmentClient,
  type InstallationBinding,
} from "../control-channel/enrollment.js";
import { HttpApprovalKeySetTransport } from "../control-channel/http-approval-key-set-transport.js";
import { HttpAuditDeliveryTransport } from "../control-channel/http-audit-delivery-transport.js";
import { HttpCommandTransport } from "../control-channel/http-command-transport.js";
import { HttpEnrollmentTransport } from "../control-channel/http-enrollment-transport.js";
import {
  FileInstallationBindingStore,
  InstallationBindingManager,
} from "../control-channel/installation-binding.js";
import { HttpRuntimeSnapshotTransport } from "../control-channel/http-runtime-snapshot-transport.js";
import { RuntimeSnapshotScheduler } from "../control-channel/runtime-snapshot-scheduler.js";
import { RuntimeSnapshotReporter } from "../control-channel/runtime-snapshot.js";
import { HttpSessionTransport } from "../control-channel/http-session-transport.js";
import {
  ControlSessionClient,
  type RuntimeReadiness,
} from "../control-channel/session.js";
import { ControlSessionSupervisor } from "../control-channel/session-supervisor.js";
import { SignedApprovalPolicyEvaluator } from "../core/policy.js";
import { ToolRegistry } from "../core/registry.js";
import {
  BridgeIdentityManager,
  FileBridgeIdentityStore,
  toPublicBridgeIdentity,
  type PublicBridgeIdentity,
  type RuntimeDeploymentMode,
} from "../identity/installation-identity.js";
import {
  ApprovalKeySetManager,
  FileApprovalKeySetStore,
} from "../security/approval-keys.js";
import { FileApprovalReplayStore } from "../security/approval-replay.js";
import { SignedApprovalVerifier } from "../security/approval.js";
import { BridgeRuntime } from "./bridge-runtime.js";
import { ControlPlaneRuntimeCoordinator } from "./control-plane-runtime-coordinator.js";

export type ProductionRuntimeRecoverableSource =
  | "session"
  | "snapshot"
  | "commands"
  | "approval_keys"
  | "audit";

export interface ProductionRuntimeOptions {
  platformBaseUrl: string;
  stateDir: string;
  runtimeVersion: string;
  deploymentMode: RuntimeDeploymentMode;
  connectorInstances?: readonly ConnectorInstance[] | undefined;
  allowInsecureHttp?: boolean | undefined;
  fetch?: typeof globalThis.fetch | undefined;
  onReadinessChange?: ((readiness: RuntimeReadiness) => void) | undefined;
  onRecoverableError?:
    | ((source: ProductionRuntimeRecoverableSource, retryDelayMs: number) => void)
    | undefined;
}

export class ProductionRuntime {
  private readonly identityManager: BridgeIdentityManager;
  private readonly bindingStore: FileInstallationBindingStore;
  private readonly bindingManager: InstallationBindingManager;
  private readonly connectorInstances: readonly ConnectorInstance[];
  private readonly connectorAdapter: ConnectorRegistryAdapter;
  private readonly registry: ToolRegistry;
  private readonly sessionSupervisor: ControlSessionSupervisor;
  private readonly snapshotScheduler: RuntimeSnapshotScheduler;
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

    this.registry = new ToolRegistry();
    this.connectorAdapter = new ConnectorRegistryAdapter(this.registry);
    this.connectorInstances = options.connectorInstances ?? [];
    for (const instance of this.connectorInstances) {
      this.connectorAdapter.register(instance);
    }
    const capabilities = this.registry.list().map((tool) => tool.id).sort();

    const transportOptions = this.httpTransportOptions();
    const sessionTransport = new HttpSessionTransport(transportOptions);
    const sessionClient = new ControlSessionClient(
      this.identityManager,
      sessionTransport,
      {
        runtimeVersion,
        capabilities,
      },
    );
    this.sessionSupervisor = new ControlSessionSupervisor(
      this.bindingManager,
      sessionClient,
      {
        onError: (_error, retryDelayMs) =>
          options.onRecoverableError?.("session", retryDelayMs),
      },
    );

    const snapshotTransport = new HttpRuntimeSnapshotTransport(transportOptions);
    const snapshotReporter = new RuntimeSnapshotReporter(
      this.connectorInstances,
      this.connectorAdapter,
      snapshotTransport,
    );
    this.snapshotScheduler = new RuntimeSnapshotScheduler(
      this.sessionSupervisor,
      snapshotReporter,
      {
        onError: (_error, retryDelayMs) =>
          options.onRecoverableError?.("snapshot", retryDelayMs),
      },
    );

    const enrollmentTransport = new HttpEnrollmentTransport(transportOptions);
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
    const binding = await this.bindingManager.require();
    const control = await this.createSecureControlLoops(binding);

    const initialReadiness = await this.readiness();
    this.options.onReadinessChange?.(initialReadiness);

    await new ControlPlaneRuntimeCoordinator(
      this.sessionSupervisor,
      this.snapshotScheduler,
      {
        auxiliaryLoops: [
          { name: "approval_keys", loop: control.approvalKeyScheduler },
          { name: "commands", loop: control.commandScheduler },
          { name: "audit", loop: control.auditScheduler },
        ],
      },
    ).run(async () => {
      const readiness = await this.readiness();
      this.options.onReadinessChange?.(readiness);
      return readiness;
    }, signal);
  }

  private async createSecureControlLoops(binding: InstallationBinding): Promise<{
    approvalKeyScheduler: ApprovalKeySyncScheduler;
    commandScheduler: CommandDeliveryScheduler;
    auditScheduler: AuditDeliveryScheduler;
  }> {
    const now = new Date();
    const approvalKeyManager = new ApprovalKeySetManager(
      binding,
      new FileApprovalKeySetStore(
        join(this.options.stateDir, "security", "approval-keyset.json"),
      ),
    );
    await approvalKeyManager.getOrBootstrap();

    const approvalReplayStore = new FileApprovalReplayStore(
      join(this.options.stateDir, "security", "approval-replay.json"),
    );
    await approvalReplayStore.prune(now);

    const verifier = new SignedApprovalVerifier({
      resolvePublicKey: async (keyId) =>
        await approvalKeyManager.resolvePublicKey(keyId),
    });
    const policy = new SignedApprovalPolicyEvaluator(verifier, {
      replayStore: approvalReplayStore,
    });

    const auditOutbox = new FileAuditOutboxStore(
      join(this.options.stateDir, "audit", "outbox.json"),
    );
    const auditSink = new SanitizedAuditSink(
      {
        tenantId: binding.tenantId,
        installationId: binding.installationId,
        bridgeInstanceId: binding.bridgeInstanceId,
      },
      auditOutbox,
    );

    const runtime = new BridgeRuntime({
      registry: this.registry,
      policy,
      audit: auditSink,
    });
    const commandReceiptStore = new FileCommandReceiptStore(
      join(this.options.stateDir, "control", "command-receipts.json"),
    );
    await commandReceiptStore.prune(now);
    const processor = new CommandProcessor(runtime, commandReceiptStore);

    const transportOptions = this.httpTransportOptions();
    const approvalKeyScheduler = new ApprovalKeySyncScheduler(
      this.sessionSupervisor,
      approvalKeyManager,
      new HttpApprovalKeySetTransport(transportOptions),
      {
        onError: (_error, retryDelayMs) =>
          this.options.onRecoverableError?.("approval_keys", retryDelayMs),
      },
    );
    const commandScheduler = new CommandDeliveryScheduler(
      this.sessionSupervisor,
      new HttpCommandTransport(transportOptions),
      processor,
      {
        onError: (_error, retryDelayMs) =>
          this.options.onRecoverableError?.("commands", retryDelayMs),
      },
    );
    const auditScheduler = new AuditDeliveryScheduler(
      this.sessionSupervisor,
      auditOutbox,
      new HttpAuditDeliveryTransport(transportOptions),
      {
        onError: (_error, retryDelayMs) =>
          this.options.onRecoverableError?.("audit", retryDelayMs),
      },
    );

    return { approvalKeyScheduler, commandScheduler, auditScheduler };
  }

  private httpTransportOptions(): {
    baseUrl: string;
    allowInsecureHttp: boolean;
    fetch?: typeof globalThis.fetch | undefined;
  } {
    return {
      baseUrl: this.options.platformBaseUrl,
      allowInsecureHttp: this.options.allowInsecureHttp ?? false,
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
    };
  }
}

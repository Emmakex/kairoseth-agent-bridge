import type {
  ConnectorCredentialRequirement,
  ConnectorManifest,
  ConnectorSecretProvider,
  JsonSchema,
} from "../sdk/contracts.js";

export interface GenericWebhookSignaturePolicy {
  type: "hmac_sha256";
  requirementId?: string | undefined;
  secretField?: string | undefined;
  signatureHeader?: string | undefined;
  timestampHeader?: string | undefined;
  eventIdHeader?: string | undefined;
  signaturePrefix?: string | undefined;
  toleranceSeconds?: number | undefined;
}

export interface GenericWebhookTriggerDefinition {
  id: string;
  name: string;
  description: string;
  route: string;
  payloadSchema: JsonSchema;
  signature: GenericWebhookSignaturePolicy;
  maxBytes?: number | undefined;
  redactKeys?: readonly string[] | undefined;
}

export interface GenericWebhookDefinition {
  manifest: ConnectorManifest;
  triggers: readonly GenericWebhookTriggerDefinition[];
}

export interface GenericWebhookRequest {
  method: string;
  headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  body: Uint8Array;
  receivedAt: string;
}

export interface NormalizedWebhookEvent {
  version: "kab.webhook-event.v1";
  eventId: string;
  connectorId: string;
  connectorInstanceId: string;
  triggerId: string;
  runtimeTriggerId: string;
  receivedAt: string;
  sourceTimestamp: string;
  payload: unknown;
}

export interface WebhookEventSink {
  emit(event: NormalizedWebhookEvent): Promise<void>;
}

export interface GenericWebhookProcessorContext {
  connectorInstanceId: string;
  secrets: ConnectorSecretProvider;
  sink: WebhookEventSink;
}

export interface GenericWebhookFactoryOptions {
  name?: string | undefined;
  version?: string | undefined;
  description?: string | undefined;
  triggers: readonly GenericWebhookTriggerDefinition[];
}

export function webhookCredentialRequirements(
  triggers: readonly GenericWebhookTriggerDefinition[],
): readonly ConnectorCredentialRequirement[] {
  const requirements = new Map<string, ConnectorCredentialRequirement>();

  for (const trigger of triggers) {
    const requirementId =
      trigger.signature.requirementId ?? `${trigger.id}-signing`;
    const secretField = trigger.signature.secretField ?? "secret";
    const existing = requirements.get(requirementId);

    if (existing) {
      const sameShape =
        existing.kind === "custom" &&
        existing.fields.length === 1 &&
        existing.fields[0]?.id === secretField;

      if (!sameShape) {
        throw new Error(
          `Webhook credential requirement ${requirementId} is declared with incompatible fields.`,
        );
      }
      continue;
    }

    requirements.set(requirementId, {
      id: requirementId,
      kind: "custom",
      label: `Webhook signing secret for ${trigger.name}`,
      required: true,
      description: "HMAC-SHA256 webhook verification secret.",
      fields: [
        {
          id: secretField,
          label: "Signing secret",
          secret: true,
          required: true,
        },
      ],
    });
  }

  return [...requirements.values()];
}

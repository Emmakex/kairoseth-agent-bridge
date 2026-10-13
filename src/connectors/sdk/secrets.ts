import { ConnectorConfigurationError } from "./errors.js";
import type { ConnectorSecretProvider } from "./contracts.js";

export async function requireConnectorSecret(
  provider: ConnectorSecretProvider,
  requirementId: string,
  fieldId: string,
): Promise<string> {
  const value = await provider.getSecret(requirementId, fieldId);

  if (value === null || value.length === 0) {
    throw new ConnectorConfigurationError(
      `Required connector credential is unavailable: ${requirementId}.${fieldId}`,
    );
  }

  return value;
}

export class ConnectorError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConnectorError";
  }
}

/**
 * Connectors throw this only when retrying the same operation is considered
 * safe under the tool's declared retry/idempotency contract.
 */
export class ConnectorTransientError extends ConnectorError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConnectorTransientError";
  }
}

export class ConnectorTimeoutError extends ConnectorTransientError {
  constructor(toolId: string, timeoutMs: number) {
    super(`Connector tool ${toolId} exceeded timeout of ${timeoutMs} ms.`);
    this.name = "ConnectorTimeoutError";
  }
}

export class ConnectorConfigurationError extends ConnectorError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConnectorConfigurationError";
  }
}

/**
 * Raised when a metadata-only credential rotation notice cannot be applied.
 * The message intentionally excludes provider/connector raw errors.
 */
export class ConnectorCredentialRotationError extends ConnectorError {
  constructor(message: string) {
    super(message);
    this.name = "ConnectorCredentialRotationError";
  }
}

/**
 * Fail-closed execution guard while credential rotation is refreshing or when
 * the most recent rotation attempt failed and requires operator remediation.
 */
export class ConnectorCredentialRotationPendingError extends ConnectorError {
  constructor(connectorId: string, connectorInstanceId: string) {
    super(
      `Connector instance ${connectorId}.${connectorInstanceId} is blocked by credential rotation.`,
    );
    this.name = "ConnectorCredentialRotationPendingError";
  }
}

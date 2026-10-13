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

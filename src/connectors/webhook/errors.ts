export type WebhookErrorCode =
  | "invalid_request"
  | "authentication_failed"
  | "timestamp_rejected"
  | "replay_conflict"
  | "payload_too_large"
  | "invalid_payload";

export class WebhookError extends Error {
  readonly name = "WebhookError";

  constructor(
    readonly code: WebhookErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

# Kairoseth Agent Bridge — Generic REST Connector v1

## Purpose

Generic REST maps a predeclared HTTP API surface into Connector SDK tools without giving agents arbitrary network access.

The connector is suitable for public SaaS APIs, customer-owned APIs and controlled on-premise HTTP services.

## Security model

The agent does **not** provide a URL.

A connector instance owns `baseUrl` configuration and each tool owns a fixed `pathTemplate`. Tool inputs may only fill declared path placeholders, query parameters and JSON body mappings.

This keeps network destination authority in installation configuration rather than agent input.

## Base URL policy

Default policy:

- HTTPS required;
- HTTP disabled;
- localhost/local hostnames blocked;
- private/link-local/special-use IP addresses blocked;
- hostname resolution checked before request;
- redirects disabled (`redirect: manual`);
- optional exact origin allowlist.

For controlled on-premise runtimes, installation configuration can explicitly enable:

```text
allowHttp
allowPrivateNetwork
```

Those options are connector-definition/deployment policy, not tool input.

The built-in DNS/IP checks are a baseline SSRF defense. High-assurance hosted deployments should additionally use controlled egress networking/proxies because application-level DNS checks cannot eliminate every DNS-rebinding/TOCTOU class by themselves.

## Operations

An operation declares:

- tool ID/name/description;
- risk (`READ`, `WRITE`, `CRITICAL`);
- HTTP method;
- fixed relative path template;
- optional query mapping;
- optional static non-secret headers;
- optional JSON body mapping;
- input/output schema descriptors;
- Connector SDK timeout/retry/idempotency behavior.

Example:

```text
GET /orders/{orderId}?expand=<input.expand>
```

Path placeholder values are URI encoded and cannot replace the request origin.

## Risk mapping

A mutating HTTP method (`POST`, `PUT`, `PATCH`, `DELETE`) cannot be classified as `READ`.

The Connector SDK then preserves that risk in the Bridge `ToolRegistry`, so WRITE/CRITICAL operations pass through the same approval policy used by every other Bridge tool.

## Authentication

Supported v1 authentication mappings:

- none;
- Bearer token;
- HTTP Basic;
- API key header.

Credential values are resolved at execution time through `ConnectorSecretProvider`.

Static operation headers may not embed authorization/cookie/host/transport-sensitive headers. Authentication headers are produced only from the credential provider.

## Request bodies

JSON bodies can use:

- the complete tool input; or
- one declared top-level input field.

GET/HEAD operations cannot declare a body.

## Redirects

Redirects are never followed automatically.

Any HTTP 3xx response is rejected. This prevents an otherwise allowed endpoint from redirecting the Bridge toward another origin or internal service.

## Response limits

Responses are read as a bounded stream.

Default maximum:

```text
1 MiB
```

Configurable range:

```text
1 KiB – 10 MiB
```

`Content-Length` is checked when present, and streaming is stopped if the actual bytes exceed the configured maximum.

## Response parsing and redaction

JSON responses are parsed and recursively redact common sensitive keys such as:

- password/secret;
- token/access_token/refresh_token;
- API keys;
- authorization/cookie/client_secret.

Additional redacted key names may be configured.

Text responses receive basic credential-pattern redaction.

The returned value is normalized as:

```ts
{
  status: number,
  ok: true,
  body: unknown
}
```

Error responses do not include arbitrary remote response bodies in exception messages.

## Retry behavior

Network failures before a response and HTTP transient statuses are represented as `ConnectorTransientError`.

Transient statuses include:

```text
408, 425, 429, 5xx
```

Actual retry behavior is still controlled by Connector SDK tool policy.

A WRITE/CRITICAL REST operation therefore cannot receive automatic retries unless it also declares idempotency.

## Health

An optional fixed `healthPath` can probe the configured service using the same network/authentication restrictions.

If no health endpoint is configured, health validates the base URL/network policy without inventing a remote API call.

## Phase 1 integration

Generic REST tools are registered through `ConnectorRegistryAdapter` and therefore inherit:

- Bridge risk/policy evaluation;
- signed approvals;
- approval nonce replay protection;
- command deduplication;
- sanitized audit lifecycle.

The acceptance test verifies that a REST READ executes through `BridgeRuntime` while a REST WRITE without approval is stopped as `approval_required` before the HTTP request executes.

## Next layer

Generic REST is the outbound/request connector. Webhook support is a separate inbound/event adapter and remains the next Phase 2 microphase.

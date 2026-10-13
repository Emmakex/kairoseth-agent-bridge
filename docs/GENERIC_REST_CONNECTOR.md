# Kairoseth Agent Bridge — Generic REST Connector v1

## Purpose

Generic REST maps a configured external HTTP API into normalized Agent Bridge tools without adding API-specific code to the bridge core.

It is intended for SaaS APIs, private/custom HTTP services and proprietary systems with stable REST-style endpoints.

It is deliberately **not** an arbitrary HTTP request tool. Agents cannot choose a destination URL, HTTP method or raw authentication value at invocation time.

## Trust boundary

The connector instance controls the remote origin through non-secret `baseUrl` configuration.

Each tool is declared ahead of time with:

- HTTP method;
- relative path template;
- input schema;
- query/body mapping;
- risk classification;
- authentication mapping;
- response policy;
- timeout/retry/idempotency behavior inherited from Connector SDK.

The agent supplies only the tool input allowed by that definition.

## Fixed origin

`baseUrl` is runtime/operator configuration, not tool input.

By default it must be an HTTPS origin such as:

```text
https://api.example.com
```

It cannot contain:

- username/password;
- query parameters;
- fragments;
- API path prefixes.

API prefixes belong in endpoint paths.

Plain HTTP requires explicit `allowHttp: true` and is intended only for deliberately trusted local/development environments.

## Endpoint paths

Endpoint paths are static relative templates beginning with `/`.

Example:

```text
/v1/orders/{orderId}
```

Template values come from declared tool input fields and are URL-encoded before insertion.

The connector rejects unsafe path definitions including:

- network-path references beginning `//`;
- backslashes;
- embedded query/fragment syntax;
- dot traversal segments.

A path value supplied by an agent cannot change the configured origin.

## Query and JSON body mapping

Query mappings bind fixed parameter names to input field paths.

Example:

```ts
query: {
  status: "filters.status",
  page: "page"
}
```

Scalar values and arrays of scalars are supported. Null/undefined values are omitted.

JSON body mapping uses `bodyInputPath`:

```text
payload      -> send input.payload
$            -> send the complete tool input
```

GET and HEAD endpoints cannot declare request bodies.

## Authentication

Authentication values always come from `ConnectorSecretProvider`.

Supported v1 mappings:

- none;
- Bearer token;
- API key in a header;
- API key in a query parameter;
- HTTP Basic.

Static configuration cannot define sensitive headers such as Authorization, cookies, token headers or API-key headers. Those must use the auth mapping so secret values stay out of connector manifests/configuration.

## Redirect policy

Redirect following is disabled.

A 3xx response is returned as a connector error rather than following the `Location` header. This prevents a configured/allowlisted endpoint from silently forwarding a request — and its credentials — to another origin.

## Retry and idempotency

Network failures and selected transient HTTP statuses are represented as `ConnectorTransientError`:

```text
408, 425, 429, 500, 502, 503, 504
```

The Connector SDK then applies the tool's declared retry policy.

For keyed idempotency, the SDK derives the idempotency key from tool input and Generic REST sends the same value as:

```text
Idempotency-Key: <value>
```

across every retry attempt.

WRITE/CRITICAL automatic retry remains impossible unless the Connector SDK definition declares idempotency.

## Responses

The connector returns a normalized result:

```json
{
  "status": 200,
  "body": {}
}
```

JSON is the default response mode. Text can be explicitly enabled per endpoint.

Response size is bounded:

- default: 1 MiB;
- hard maximum configurable by v1: 5 MiB.

Both declared Content-Length and the decoded body size are checked.

## Response redaction

Redaction happens before the remote response becomes tool output.

The connector recursively redacts common sensitive keys including token/password/secret/API-key/private-key fields. Endpoint definitions may add application-specific redaction keys.

Resolved authentication values are also removed when echoed by the remote service, and Bearer-looking text is masked in text responses.

This is defense in depth. External APIs should still be configured to return only data the agent is authorized to receive.

## Error handling

Non-success response bodies are not surfaced in connector error messages. This reduces the risk that an upstream service places credentials, PII or internal diagnostics into the Agent Bridge audit/error stream.

Transport errors and transient statuses can be retried according to SDK policy; ordinary HTTP failures are not automatically retried.

## Example

```ts
const connector = createGenericRestConnector({
  auth: {
    type: "bearer",
    requirementId: "api",
    tokenField: "token",
  },
  endpoints: [
    {
      id: "orders.get",
      name: "Get order",
      description: "Read one order",
      risk: "READ",
      method: "GET",
      inputSchema: {
        type: "object",
        properties: { orderId: { type: "integer" } },
        required: ["orderId"],
      },
      request: {
        path: "/v1/orders/{orderId}",
      },
      outputSchema: { type: "object" },
    },
  ],
});
```

After registering an instance named `erp-prod`, the runtime tool becomes:

```text
generic-rest.erp-prod.orders.get
```

and still runs through the standard Agent Bridge policy/audit execution path.

## Non-goals of v1

Generic REST v1 does not provide:

- arbitrary destination URLs from tool input;
- automatic redirect following;
- interactive OAuth authorization flows;
- multipart file uploads;
- streaming tool output;
- SOAP or GraphQL-specific abstractions;
- inbound webhook hosting.

Inbound/outbound webhook adaptation is the next Phase 2 layer and should reuse the Connector SDK rather than weakening the Generic REST boundary.

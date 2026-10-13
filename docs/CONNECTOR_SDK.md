# Kairoseth Agent Bridge — Connector SDK v1

## Purpose

The Connector SDK is the common contract used to expose heterogeneous business systems through the same Agent Bridge runtime.

A connector may target WooCommerce, PrestaShop, a public SaaS API, an on-premise ERP, a CRM, MySQL, a filesystem, a NAS or custom software. The connector implementation changes; the bridge security and execution model does not.

## Design boundary

The Connector SDK does not implement tenant management, approvals, audit policy or agent authorization.

Those controls remain in the Agent Bridge core / Kairoseth Platform control channel.

Connectors provide:

- identity and version metadata;
- capabilities;
- non-secret configuration schema;
- credential requirements metadata;
- normalized tools;
- input/output schema descriptors;
- risk classification;
- timeout/retry/idempotency behavior hints;
- optional health checks;
- execution logic for the target system.

## Connector manifest

A connector declares a `ConnectorManifest`:

```ts
{
  id: "woocommerce",
  name: "WooCommerce",
  version: "1.0.0",
  description: "...",
  capabilities: ["orders.read", "orders.write", "products.read"],
  configSchema: { ... },
  credentials: [ ... ]
}
```

IDs use a restricted lowercase slug/dot/dash/underscore format so runtime tool IDs are deterministic.

Versions use semantic-version form.

## Connector instances

A connector definition is reusable. A customer may have several instances of the same connector.

Example:

```text
connector type: woocommerce
instance A: shop-bcn
instance B: shop-madrid
```

Runtime tool IDs are namespaced as:

```text
<connector-id>.<instance-id>.<tool-id>
```

For example:

```text
woocommerce.shop-bcn.orders.list
woocommerce.shop-madrid.orders.list
```

This prevents two customer systems from silently sharing a runtime tool identity.

## Configuration vs credentials

Non-secret configuration belongs in `config` and is described by `configSchema`.

Examples:

- base URL;
- allowed database name;
- store identifier;
- timezone;
- feature toggles;
- allowed filesystem root alias.

Credentials are different.

A manifest declares only credential **metadata**:

- requirement ID;
- credential kind;
- fields;
- whether fields are secret/required;
- labels/descriptions.

Credential values are never included in the manifest, tool schema or normal connector configuration.

At execution time a connector receives a `ConnectorSecretProvider` and asks for the exact credential field it needs.

```ts
await requireConnectorSecret(context.secrets, "api", "token")
```

The storage backend remains external to the connector implementation. It can later map to Kairoseth-managed secret storage, protected local storage, environment injection or another approved backend.

## Tool contracts

Each connector tool declares:

- local tool ID;
- name and description;
- `READ`, `WRITE` or `CRITICAL` risk;
- JSON-Schema-compatible input descriptor;
- optional output descriptor;
- optional behavior policy;
- execution handler.

The Bridge adapter preserves the risk class when registering the tool into the core `ToolRegistry`. Connector code cannot bypass the Bridge policy gate by registering a different execution path.

## JSON-Schema-compatible descriptors

The SDK currently defines a deliberately small JSON-Schema-compatible TypeScript contract rather than coupling the bridge core to a particular schema-validation package.

Supported descriptive fields include:

- primitive/object/array types;
- properties and required fields;
- additional properties;
- items;
- enum/const;
- oneOf/anyOf/allOf;
- numeric bounds;
- string length/pattern/format;
- descriptions and defaults.

This is enough to describe initial connector tools and later generate/translate contracts for REST, MCP, A2A and Kairoseth Platform UI surfaces.

Runtime input validation can be added through a dedicated schema-validator layer without changing connector manifests.

## Execution context

A connector tool receives `ConnectorToolExecutionContext` containing:

- original `InvocationContext`;
- connector type ID;
- connector instance ID;
- non-secret instance config;
- secret provider;
- `AbortSignal` controlled by the runtime.

The connector never receives the Kairoseth control-session access token.

## Timeouts

Every registered connector tool executes with a bounded timeout.

Default runtime timeout:

```text
30 seconds
```

A tool can declare its own timeout between 100 ms and 300 seconds.

When the timeout expires:

1. the runtime aborts the tool `AbortSignal`;
2. the adapter rejects with `ConnectorTimeoutError`;
3. retry policy may apply only if the tool is allowed to retry.

JavaScript cannot forcibly cancel arbitrary external work, so connector implementations must propagate the provided `AbortSignal` into HTTP/database/client libraries where supported.

## Retry model

Retries are opt-in.

A connector must throw `ConnectorTransientError` (or `ConnectorTimeoutError`) to mark a failure as transient. Ordinary exceptions are not retried automatically.

Retry mode:

```text
never
transient
```

Transient retries use bounded exponential delays.

This keeps validation/configuration errors from accidentally becoming retry storms.

## Mutation safety and idempotency

`WRITE` and `CRITICAL` tools may not enable automatic transient retries unless they declare idempotency.

Supported idempotency modes:

- `none` — no automatic mutation retries;
- `intrinsic` — the remote operation is inherently idempotent;
- `keyed` — the operation uses an explicit idempotency key in input.

For keyed idempotency, `keyField` is required.

This rule is separate from Agent Bridge command deduplication and approval replay protection. All three layers serve different failure/replay boundaries.

## Health checks

Connectors may define a health function receiving the same non-secret config/secret-provider model and an AbortSignal.

Health states:

- `healthy`;
- `degraded`;
- `unhealthy`.

The bridge adapter bounds health checks with a runtime timeout. A connector with no custom health implementation reports a basic healthy state rather than inventing a remote probe.

## Error taxonomy

The SDK exposes:

- `ConnectorError` — base connector error;
- `ConnectorTransientError` — explicitly retryable failure;
- `ConnectorTimeoutError` — runtime timeout, transient class;
- `ConnectorConfigurationError` — missing/invalid connector configuration or required secret.

Connector authors should avoid embedding raw credentials or sensitive response bodies in error messages because sanitized audit is defense in depth, not a substitute for safe error construction.

## Registration adapter

`ConnectorRegistryAdapter` validates the connector definition and registers every connector tool into the existing Bridge `ToolRegistry`.

This is the key architectural bridge:

```text
Connector SDK tool
       |
       v
ConnectorRegistryAdapter
       |
       v
ToolRegistry / BridgeRuntime
       |
       +--> policy
       +--> signed approval
       +--> command dedup
       +--> audit
```

Connectors therefore inherit the Phase 1 control-channel/security model instead of reimplementing it.

## Initial connectors

The first implementations on top of this SDK are planned as:

1. Generic REST / Webhook
2. WooCommerce
3. MySQL
4. Files
5. PrestaShop and customer-specific ERP/CRM adapters

The Generic REST connector is next because it proves that a public/custom API can be mapped into normalized tools without changing Bridge core code.

## Non-goals of Connector SDK v1

This first SDK layer does not yet provide:

- a full JSON Schema validation engine;
- OAuth interactive authorization flows;
- connector package signing/catalog distribution;
- automatic credential provisioning;
- arbitrary SQL execution;
- protocol-specific MCP/A2A mapping;
- generic webhook server exposure.

Those are built as explicit layers on top of the stable connector contract.

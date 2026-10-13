# Kairoseth Agent Bridge — MCP Adapter

## Purpose

The MCP adapter exposes the existing Agent Bridge `ToolRegistry` through Model Context Protocol semantics without creating a second execution or authorization path.

The adapter targets the modern MCP architecture and keeps protocol concerns separate from Kairoseth security concerns.

## Security boundary

MCP is a protocol surface, not an authorization authority.

The invariant is:

```text
MCP client
   |
   | tools/list / tools/call
   v
MCP adapter
   |
   v
BridgeRuntime.invoke()
   |
   +--> ToolRegistry
   +--> PolicyEvaluator
   +--> signed approval verification
   +--> replay protection
   +--> audit
   v
Connector / tool execution
```

The MCP adapter must never invoke `ToolDefinition.execute()` directly.

Client-provided MCP metadata such as `clientInfo` is self-reported protocol metadata and is not used to decide tenant, installation, actor permissions or approval state. The authenticated hosting/transport layer supplies an `InvocationContext` from Kairoseth trust state.

## MCP tool discovery

`McpToolAdapter.listTools()` maps registered Bridge tools into MCP tool descriptors.

Tool names preserve the Bridge namespace, for example:

```text
generic-rest.crm-prod.customers.get
```

Names are validated against the interoperable MCP tool-name profile:

- 1–128 characters;
- ASCII letters;
- digits;
- underscore;
- dash;
- dot.

Discovery ordering is deterministic by tool name.

### Cache hints

The baseline result is:

```text
ttlMs: 0
cacheScope: private
```

This is intentionally conservative because tool visibility may later vary by Kairoseth authorization context. A transport/authorization layer may only relax these hints after proving that the advertised tool set is identical across the relevant callers.

## Schemas

Core `ToolDefinition` now supports optional protocol-neutral:

- `inputSchema`;
- `outputSchema`;
- execution hints.

The Connector SDK preserves its JSON-Schema-compatible descriptors when registering a connector tool into the core `ToolRegistry`.

This avoids coupling the core to MCP while allowing MCP, A2A and future protocol adapters to reuse the same discovery metadata.

A legacy/core tool with no input schema receives this discovery fallback:

```json
{
  "type": "object",
  "additionalProperties": true
}
```

The adapter serializes schemas through JSON before exposing them and rejects non-JSON schema roots.

## Tool annotations

MCP annotations are generated from Bridge metadata as descriptive hints only.

### READ

```text
readOnlyHint: true
destructiveHint: false
```

### WRITE

```text
readOnlyHint: false
destructiveHint: true by conservative default
```

A future trusted tool definition may explicitly state a non-destructive mutation hint, but this does not change the Bridge risk level.

### CRITICAL

```text
readOnlyHint: false
destructiveHint: true
```

### Idempotency

Connector tools whose SDK idempotency mode is `intrinsic` or `keyed` advertise:

```text
idempotentHint: true
```

### Open-world behavior

Connector tools are currently marked `openWorld: true` when moved into the core registry because they interact with external business systems.

These annotations must never be used by the Bridge as proof that an action is safe or authorized.

## Tool invocation

`McpToolAdapter.callTool()` accepts:

- tool name;
- object arguments;
- an already-authenticated Kairoseth `InvocationContext` from the hosting layer.

The adapter delegates to:

```text
BridgeRuntime.invoke(toolName, arguments, invocationContext)
```

This preserves all existing READ / WRITE / CRITICAL policy behavior.

## Result mapping

### Executed

Successful JSON-compatible output is returned as both:

- MCP text content;
- `structuredContent`.

Strings remain strings; objects/arrays/numbers/booleans/null remain their JSON values.

Non-JSON JavaScript values fall back to text-only output rather than breaking a successfully completed Bridge invocation.

### Approval required

The adapter returns an MCP tool error result with safe structured metadata:

```json
{
  "code": "KAIROSETH_APPROVAL_REQUIRED",
  "correlationId": "..."
}
```

No approval token or policy secret is exposed.

### Denied

```text
KAIROSETH_DENIED
```

### Execution failure

```text
KAIROSETH_EXECUTION_FAILED
```

Execution failures return a generic MCP-facing message plus correlation ID. The raw internal exception text is not copied into MCP output by the adapter.

## Unknown tools and malformed names

Unknown tools and invalid MCP tool names are protocol-adapter errors. The transport layer will map these to the corresponding MCP/JSON-RPC error response in the transport microphase.

## Protocol/transport split

This first MCP microphase deliberately does not embed the official MCP TypeScript server package yet.

It stabilizes:

- discovery mapping;
- schemas;
- annotations;
- result mapping;
- policy-safe invocation.

The next microphase binds this adapter to the official MCP TypeScript SDK v2 and modern Streamable HTTP / stdio transports.

Keeping these layers separate makes it possible to test the most important invariant — MCP cannot bypass Kairoseth policy — without also debugging HTTP/stdio framing.

## Modern MCP direction

The modern MCP revision is stateless at the protocol core: authorization and application state must not depend on a hidden protocol session. That aligns with Agent Bridge because tenant/installation identity belongs to Kairoseth's authenticated hosting/control plane, not to MCP self-reported metadata.

The transport implementation must keep modern request metadata and Kairoseth authorization context separate.

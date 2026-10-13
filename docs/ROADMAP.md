# Kairoseth Agent Bridge — Roadmap

## Objective

Deliver a reusable, secure bridge that lets Kairoseth products and external AI agents interact with business systems through one normalized tool layer.

The roadmap favors small verifiable slices. Each phase must keep the control-plane boundary intact and leave CI green before the next phase starts.

Agent Bridge is managed from the existing Kairoseth Platform at `kairoseth.com`; runtime placement adapts to the customer system. See `docs/RUNTIME_DEPLOYMENT.md`.

## Cross-cutting product rules

- [x] ES/EN is the product language contract for user/agent-facing descriptive text
- [x] Technical IDs, protocol fields and security decisions remain locale-independent
- [x] Tool/connector localization is defined once in core contracts and reused by protocol adapters

See `docs/I18N.md`.

## Phase 0 — Bootstrap and contracts

Status: **complete**

- [x] Initialize repository
- [x] Document control-plane / execution-plane boundary
- [x] Define READ / WRITE / CRITICAL risk model
- [x] Define normalized tool invocation contracts
- [x] Implement tool registry
- [x] Implement secure-default policy evaluator
- [x] Implement runtime execution lifecycle
- [x] Add audit sink contract
- [x] Add unit tests for core invariants
- [x] Get bootstrap CI green
- [x] Merge bootstrap PR to `main`

Exit condition achieved: a read-only tool executes end-to-end; mutating tools cannot bypass the policy gate.

## Phase 1 — Kairoseth native control channel

Status: **complete**

- [x] Define persistent Ed25519 bridge identity
- [x] Add atomic filesystem identity persistence baseline
- [x] Define challenge-based installation registration contract
- [x] Ensure tenant + installation binding is assigned by Kairoseth Platform, not self-asserted by the runtime
- [x] Add signed runtime registration proof and key-possession verification helper
- [x] Persist authoritative installation binding in runtime storage
- [x] Validate persisted binding against the active bridge identity
- [x] Define outbound-only authenticated session lifecycle
- [x] Add short-lived authenticated bridge session credential contract
- [x] Bind session credential to tenant + installation + bridge instance + key
- [x] Add signed session proof using the registered bridge identity
- [x] Add signed approval decision verifier
- [x] Bind approval to tenant, installation, tool, correlation ID and exact action fingerprint
- [x] Add persistent single-use replay enforcement for signed approval nonce
- [x] Complete trusted approval public-key bootstrap and signed rotation channel
- [x] Add heartbeat, readiness and capability advertisement contract
- [x] Add automatic session renewal before expiry
- [x] Add reconnect/backoff behavior with bounded jitter
- [x] Add durable command delivery + acknowledgement contract
- [x] Add command-level crash-safe deduplication with two-phase receipts
- [x] Add sanitized durable audit event delivery over the control channel
- [x] Add event-level ACK/retry semantics with stable event IDs
- [x] Add Phase 1 end-to-end acceptance scenario
- [x] Document adaptive runtime deployment model
- [x] Document installation enrollment protocol v1
- [x] Document outbound control session protocol v1
- [x] Document runtime state persistence and session resilience
- [x] Document command delivery protocol v1
- [x] Document single-use approval replay protection
- [x] Document approval key rotation protocol v1
- [x] Document sanitized audit delivery protocol v1

Exit condition achieved: an enrolled local bridge establishes an outbound authenticated session, executes an approved WRITE once according to policy, blocks command redelivery and approval-token replay, maintains a rotatable Platform trust chain, and delivers a sanitized reliable audit trail.

## Phase 2 — Connector SDK + Generic REST/Webhook

Status: **complete**

- [x] Extract Connector SDK contracts
- [x] Add JSON-Schema-compatible config/input/output descriptors
- [x] Add connector capability manifest
- [x] Add secret requirement descriptors without exposing values
- [x] Add secret-provider runtime abstraction
- [x] Add instance-scoped tool registration into the core ToolRegistry
- [x] Preserve READ / WRITE / CRITICAL risk through connector registration
- [x] Add bounded tool timeout and abort signal
- [x] Add explicit transient-error retry hooks
- [x] Require declared idempotency before automatic WRITE/CRITICAL retry
- [x] Add optional connector health contract
- [x] Document Connector SDK v1
- [x] Implement Generic REST connector
- [x] Add Generic REST authentication mappings through SecretProvider
- [x] Add controlled path/query/body request mapping
- [x] Add HTTPS/public-network defaults, redirect blocking and optional origin allowlist
- [x] Add bounded response streaming and response redaction rules
- [x] Add Generic REST health probe contract
- [x] Add Connector SDK + Generic REST acceptance scenario through BridgeRuntime policy/audit
- [x] Document Generic REST connector v1
- [x] Implement webhook trigger/output adapter without embedding an HTTP server
- [x] Add HMAC/Bearer webhook authentication, timestamp validation and persistent nonce replay controls
- [x] Add deterministic normalized webhook events and durable idempotent event outbox
- [x] Add webhook payload bounds and pre-output redaction
- [x] Preserve outbound-only default by keeping ingress in deployment adapters
- [x] Add Phase 2 end-to-end REST + Webhook acceptance scenario
- [x] Document Webhook Adapter v1

Exit condition achieved: external SaaS/custom HTTP APIs and authenticated webhook events can be exposed through normalized Bridge contracts without custom runtime-core code and without bypassing Phase 1 policy/audit controls.

## Phase 3 — MCP

Status: **complete**

- [x] Add protocol-neutral discovery metadata to core ToolDefinition
- [x] Preserve Connector SDK input/output schemas and execution hints in ToolRegistry
- [x] Implement MCP tool discovery adapter over ToolRegistry
- [x] Add deterministic MCP tool ordering and conservative private cache hints
- [x] Map READ / WRITE / CRITICAL into descriptive MCP annotations without using hints as authority
- [x] Route MCP tool calls through BridgeRuntime instead of direct tool execution
- [x] Map executed / approval-required / denied / failed Bridge results to MCP tool results
- [x] Add MCP adapter policy/security unit tests
- [x] Document MCP adapter security boundary
- [x] Bind adapter to official MCP TypeScript SDK v2
- [x] Add modern Streamable HTTP transport for MCP 2026-07-28
- [x] Add stdio transport for local/dev interoperability
- [x] Map verified transport auth into authenticated Kairoseth InvocationContext
- [x] Reject legacy MCP by default, with explicit stateless opt-in only
- [x] Add ES/EN discovery and safe result localization without localizing technical IDs
- [x] Add interoperability tests with the official MCP SDK client
- [x] Add Phase 3 end-to-end acceptance scenario covering identity, policy and audit

Exit condition achieved: an MCP-compatible agent can discover and invoke Agent Bridge tools through supported MCP transports without bypassing Kairoseth identity, policy, approvals or audit.

## Phase 4 — First business connectors

Status: **in progress**

### WooCommerce

Initial surface status: **complete**

- [x] Add official connector wrapper over Generic REST / Connector SDK
- [x] Use WC REST API v3 with SecretProvider consumer key/secret
- [x] list/get orders — READ
- [x] list/get products and stock — READ
- [x] update order status from a strict allowlist — WRITE
- [x] update only allowlisted product stock fields — WRITE
- [x] Require approval before every WooCommerce mutation under secure-default policy
- [x] Disable automatic mutation retries while retaining intrinsic-idempotency metadata
- [x] Reject arbitrary WooCommerce bodies, unsupported fields and unsafe values before HTTP
- [x] Publish ES/EN titles/descriptions for tools, manifest and credential setup metadata
- [x] Add WooCommerce READ/auth/network/stock tests
- [x] Add WooCommerce WRITE approval/payload/idempotency tests
- [x] Document WooCommerce connector READ/WRITE baseline in ES/EN

Optional future WooCommerce expansion must add separate allowlisted tools rather than a generic product/order update endpoint.

Deployment may use a WordPress/WooCommerce connector plugin, hosted runtime, or lightweight local runtime according to the target hosting environment.

### PrestaShop

Initial direction:

- [ ] native module/connector
- [ ] normalized product/order/customer tools
- [ ] sidecar/local runtime support when local access is required
- [ ] publish ES/EN titles and descriptions for all official tools

### MySQL

Initial model:

- [ ] parameterized read profiles — READ
- [ ] explicitly declared mutation profiles — WRITE/CRITICAL
- [ ] no arbitrary SQL by default

### Files

Initial model:

- [ ] list/read allowed roots — READ
- [ ] create/update allowed roots — WRITE
- [ ] delete/move sensitive paths — CRITICAL

### ERP / CRM / custom software

- [ ] hosted API connector path for SaaS systems
- [ ] local runtime path for on-premise systems
- [ ] REST/Webhook/SDK adapter path for proprietary software
- [ ] ES/EN descriptive metadata for official Kairoseth adapters

Exit condition: the first Kairoseth products can consume real business-system connectors through the same bridge contract regardless of deployment mode.

## Phase 5 — A2A + agent interoperability

- [ ] Implement A2A skill adapter
- [ ] Add agent identity mapping
- [ ] Add delegated authorization model
- [ ] Add invocation provenance
- [ ] Add cross-agent correlation and audit
- [ ] Reuse the core ES/EN localization contract for A2A discovery metadata

Exit condition: MCP, A2A and Kairoseth-native callers share one execution and policy core.

## Phase 6 — Production hardening

- [ ] Encrypted temporary local queue
- [ ] General replay/idempotency hardening for clustered/shared deployments
- [ ] Payload/rate limits
- [ ] Circuit breakers
- [ ] Connector health isolation
- [ ] Credential rotation hooks
- [ ] Signed releases
- [ ] SBOM
- [ ] Security scanning
- [ ] Threat model
- [ ] Failure/rollback drills
- [ ] Installation/update strategy for local bridge
- [ ] Docker packaging
- [ ] Linux service packaging
- [ ] Windows service packaging
- [ ] Observability dashboards in Kairoseth Platform
- [ ] ES/EN installer/operator-facing surfaces

Exit condition: production-ready bridge runtime for hosted, hybrid and on-premises installations.

## Product integration order

The bridge is transversal infrastructure. Initial consumers should integrate through contracts rather than forks:

1. IA Empleado
2. CRA/Product Security workflows
3. VeriFactu/ERP connector scenarios where the bridge is only the transport/integration edge
4. DeCA connector scenarios
5. Future Kairoseth Extensions and customer-specific agents

This order can change based on which integration provides the fastest real end-to-end proof, but no consumer should own a private copy of the bridge runtime.

## Architecture rule

Do not create one independent runtime per product or per connector.

Maintain one shared Agent Bridge core and package/adapt it for the target environment:

- hosted runtime;
- Docker/local runtime;
- Linux/Windows service;
- WordPress connector;
- PrestaShop connector;
- Connector SDK/custom adapter.

All variants must preserve the same identity, policy, signed approval, audit, normalized-tool and ES/EN localization contracts.

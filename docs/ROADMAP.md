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

Status: **complete**

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

Initial surface status: **complete**

- [x] Add official connector over Connector SDK and shared network guardrails
- [x] Use native PrestaShop Webservice `/api/`
- [x] Authenticate with SecretProvider Webservice key via Basic Auth without putting the key in URLs
- [x] Support root and subfolder PrestaShop installations
- [x] list/get orders — READ
- [x] list configured order states — READ
- [x] list/get products — READ
- [x] get stock by product/combination through `stock_availables` — READ
- [x] update order status through `order_histories` — WRITE
- [x] update absolute StockAvailable quantity through verified partial PATCH — WRITE
- [x] Require approval before every PrestaShop mutation under secure-default policy
- [x] Disable automatic mutation retries and distinguish non-idempotent history from intrinsic absolute-stock idempotency
- [x] Verify StockAvailable target ownership before PATCH to prevent wrong-record mutation
- [x] Reject arbitrary Webservice resources, XML bodies, unsupported fields and unsafe values
- [x] Publish ES/EN titles/descriptions for tools, manifest and credential setup metadata
- [x] Add PrestaShop auth/routing/filter/stock/redaction tests
- [x] Add PrestaShop WRITE approval/XML/target-verification/idempotency tests
- [x] Document PrestaShop READ/WRITE surface in ES/EN

Optional future customer READ tools should only be added when a concrete product workflow requires customer data. Future PrestaShop expansion must use separate allowlisted tools rather than exposing an arbitrary Webservice resource client.

Deployment may use a native PrestaShop module, hosted runtime, or sidecar/local runtime depending on hosting and network access requirements.

### MySQL

Initial surface status: **complete**

- [x] Add official declared-profile connector over Connector SDK
- [x] Use `mysql2/promise` prepared statements through `execute()`
- [x] Parameterized READ profiles with strict typed inputs
- [x] Execute READ profiles inside `START TRANSACTION READ ONLY`
- [x] Require a SQL `LIMIT` plus normalized `maxRows` bounds for READ profiles
- [x] Explicitly declared mutation profiles — WRITE/CRITICAL
- [x] Require DELETE profiles to be CRITICAL
- [x] Require approval before database mutations under secure-default policy
- [x] Disable automatic retries for all mutations
- [x] Support explicit mutation idempotency metadata
- [x] Reject arbitrary SQL, multi-statements, comments, DDL and dangerous file-output capabilities
- [x] Validate exact `?` placeholder / parameter count
- [x] Reject undeclared agent input fields before database execution
- [x] Add recursive sensitive-column redaction and row-count bounds
- [x] Resolve username/password/TLS CA through SecretProvider
- [x] Require verified TLS by default with explicit deployment opt-out for controlled local networks
- [x] Support exact database-host allowlisting
- [x] Publish connector/setup/profile metadata in ES/EN
- [x] Add policy/retry/TLS/host/SQL-validation/redaction/result-bound tests
- [x] Document MySQL connector in ES/EN

Future MySQL expansion must extend the profile contract explicitly. Agent-supplied SQL, dynamic table/column identifiers and unrestricted administrative/DDL profiles remain out of scope by default.

### Files

Initial surface status: **complete**

- [x] Add root-scoped filesystem connector over Connector SDK
- [x] Declare trusted absolute roots only in deployment code/configuration
- [x] list/read allowed roots — READ
- [x] create/update allowed roots — WRITE
- [x] delete/move sensitive paths — CRITICAL
- [x] Require approval before WRITE/CRITICAL filesystem mutations under secure-default policy
- [x] Reject absolute agent paths, traversal segments, backslashes, colon/ADS and control characters
- [x] Block dotfiles by default with explicit root opt-in
- [x] Support optional file-extension allowlists
- [x] Canonicalize roots and reject symlink traversal with segment `lstat`
- [x] Use `O_NOFOLLOW` on final opens when supported by the platform
- [x] Restrict delete/move to regular files inside the same root
- [x] Require explicit overwrite for existing write/move destinations
- [x] Add bounded UTF-8/base64 reads/writes with SHA-256 on file content
- [x] Disable automatic retries for WRITE/CRITICAL and retry only recognized transient READ failures
- [x] Publish connector/root/tool metadata in ES/EN
- [x] Add real-filesystem tests for traversal, symlinks, bounds, extensions, approvals, overwrite and move/delete
- [x] Document Files connector in ES/EN

Future Files expansion must retain root-scoped tools. Arbitrary absolute paths, recursive destructive operations and implicit cross-root moves remain out of scope by default.

### ERP / CRM / custom software

Reusable integration paths already provided by the shared core:

- [x] hosted API connector path for SaaS systems through Generic REST / Connector SDK
- [x] local runtime path for on-premise systems through the native control channel and adaptive runtime deployment model
- [x] REST/Webhook/SDK adapter path for proprietary software through Phase 2 contracts
- [x] ES/EN descriptive metadata contract for official Kairoseth adapters

### Phase 4 integration acceptance

- [x] Register WooCommerce, PrestaShop, MySQL and Files instances in one ToolRegistry
- [x] Prove READ tools from every connector execute through the same BridgeRuntime contract
- [x] Prove WRITE/CRITICAL tools from every connector are blocked by secure-default approval policy
- [x] Prove connector namespaces and ES/EN discovery coexist without collisions
- [x] Add Phase 4 end-to-end acceptance scenario and mark phase complete

Exit condition achieved: WooCommerce, PrestaShop, MySQL and Files coexist in one normalized registry/runtime; READ operations execute through the shared core, mutating operations cannot bypass approval, audit remains common, and ES/EN discovery preserves stable technical IDs. Hosted and local/custom integration paths reuse the same contracts regardless of deployment mode.

## Phase 5 — A2A + agent interoperability

Status: **complete**

- [x] Implement A2A 1.0 Agent Card / skill discovery adapter over ToolRegistry
- [x] Reuse the core ES/EN localization contract for A2A Agent Card and skill metadata
- [x] Add a versioned structured Kairoseth A2A tool-invocation extension profile
- [x] Route A2A `SendMessage` tool execution through BridgeRuntime policy/approval/audit
- [x] Map Bridge approval requirements to `TASK_STATE_AUTH_REQUIRED`
- [x] Add exact actor + tenant + installation task scoping and `GetTask` baseline
- [x] Preserve original action fingerprint and correlation ID across approved task resume
- [x] Reject identity/approval spoofing from untrusted A2A message metadata
- [x] Add ES/EN A2A execution status messages and protocol documentation
- [x] Add verified A2A transport identity mapping into authoritative Kairoseth actor/tenant/installation context
- [x] Add signed delegated authorization with exact tool/risk scope and fail-closed revocation hooks
- [x] Prove delegated WRITE access still requires the normal Kairoseth action approval
- [x] Add ES/EN identity/delegation documentation and integrated acceptance coverage
- [x] Add protocol-neutral invocation provenance with root/parent correlation lineage
- [x] Add sanitized cross-agent correlation and durable audit propagation
- [x] Preserve original provenance across approval-required A2A task resume
- [x] Add ES/EN invocation provenance documentation
- [x] Pin `@a2a-js/sdk` 1.3.0 as the official interoperability test client
- [x] Parse Kairoseth Agent Card through the official A2A SDK v1 ProtoJSON model
- [x] Validate official JSON-RPC `SendMessage` READ execution and JSON Artifact decoding
- [x] Validate official JSON-RPC WRITE -> `TASK_STATE_AUTH_REQUIRED` with zero side effects
- [x] Validate official SDK `GetTask` for the approval-required task lifecycle
- [x] Validate `A2A-Version: 1.0` and `A2A-Extensions` negotiation
- [x] Keep A2A v0.3 compatibility disabled by default and document explicit opt-in only
- [x] Add Phase 5 end-to-end official SDK acceptance and ES/EN interoperability documentation

Production-durable/clustered A2A task storage remains part of Phase 6 hardening; the Phase 5 baseline uses an injectable task-store contract with a scope-safe in-memory implementation for local/dev/tests.

Exit condition achieved: MCP, A2A and Kairoseth-native callers share one execution and policy core. A2A v1 callers can discover Kairoseth tools and use the official JavaScript SDK JSON-RPC client for SendMessage/GetTask while authenticated identity, signed delegation, action approval, provenance, correlation and audit remain authoritative Kairoseth controls.

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

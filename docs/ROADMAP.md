# Kairoseth Agent Bridge — Roadmap

## Objective

Deliver a reusable, secure bridge that lets Kairoseth products and external AI agents interact with business systems through one normalized tool layer.

The roadmap favors small verifiable slices. Each phase must keep the control-plane boundary intact and leave CI green before the next phase starts.

Agent Bridge is managed from the existing Kairoseth Platform at `kairoseth.com`; runtime placement adapts to the customer system. See `docs/RUNTIME_DEPLOYMENT.md`.

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

Status: **in progress**

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
- [ ] Add replay/idempotency enforcement for approval nonce
- [ ] Complete trusted public-key bootstrap / rotation channel
- [x] Add heartbeat, readiness and capability advertisement contract
- [x] Add automatic session renewal before expiry
- [x] Add reconnect/backoff behavior with bounded jitter
- [x] Add durable command delivery + acknowledgement contract
- [x] Add command-level crash-safe deduplication with two-phase receipts
- [ ] Add sanitized audit event delivery over the control channel
- [x] Document adaptive runtime deployment model
- [x] Document installation enrollment protocol v1
- [x] Document outbound control session protocol v1
- [x] Document runtime state persistence and session resilience
- [x] Document command delivery protocol v1

Exit condition: a local bridge can establish an outbound authenticated session and safely execute an approved WRITE operation exactly once according to policy.

## Phase 2 — Connector SDK + Generic REST/Webhook

- [ ] Extract Connector SDK
- [ ] Add JSON-schema-style input/output descriptors
- [ ] Add connector capability manifest
- [ ] Add secret requirement descriptors without exposing values
- [ ] Add timeout, retry and idempotency hooks
- [ ] Implement Generic REST connector
- [ ] Implement webhook trigger/output adapter
- [ ] Add response redaction rules

Exit condition: an external SaaS API can be exposed as normalized bridge tools without custom runtime code.

## Phase 3 — MCP

- [ ] Implement MCP server adapter over the normalized registry
- [ ] Map tool schemas and descriptions
- [ ] Preserve risk metadata internally
- [ ] Route mutating MCP tool calls through the same approval engine
- [ ] Add MCP interoperability tests

Exit condition: an MCP-compatible agent can discover and invoke Agent Bridge tools without bypassing Kairoseth policy.

## Phase 4 — First business connectors

### WooCommerce

Initial tool set:

- [ ] list/get orders — READ
- [ ] list/get products and stock — READ
- [ ] update order metadata/status — WRITE
- [ ] update stock/product data — WRITE

Deployment may use a WordPress/WooCommerce connector plugin, hosted runtime, or lightweight local runtime according to the target hosting environment.

### PrestaShop

Initial direction:

- [ ] native module/connector
- [ ] normalized product/order/customer tools
- [ ] sidecar/local runtime support when local access is required

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

Exit condition: the first Kairoseth products can consume real business-system connectors through the same bridge contract regardless of deployment mode.

## Phase 5 — A2A + agent interoperability

- [ ] Implement A2A skill adapter
- [ ] Add agent identity mapping
- [ ] Add delegated authorization model
- [ ] Add invocation provenance
- [ ] Add cross-agent correlation and audit

Exit condition: MCP, A2A and Kairoseth-native callers share one execution and policy core.

## Phase 6 — Production hardening

- [ ] Encrypted temporary local queue
- [ ] Replay protection and idempotency store
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

All variants must preserve the same identity, policy, signed approval, audit and normalized-tool contracts.

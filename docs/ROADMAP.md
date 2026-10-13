# Kairoseth Agent Bridge — Roadmap

## Objective

Deliver a reusable, secure bridge that lets Kairoseth products and external AI agents interact with business systems through one normalized tool layer.

The roadmap favors small verifiable slices. Each phase must keep the control-plane boundary intact and leave CI green before the next phase starts.

## Phase 0 — Bootstrap and contracts

Status: **in progress**

- [x] Initialize repository
- [x] Document control-plane / execution-plane boundary
- [x] Define READ / WRITE / CRITICAL risk model
- [x] Define normalized tool invocation contracts
- [x] Implement tool registry
- [x] Implement secure-default policy evaluator
- [x] Implement runtime execution lifecycle
- [x] Add audit sink contract
- [x] Add unit tests for core invariants
- [ ] Get bootstrap CI green
- [ ] Merge bootstrap PR to `main`

Exit condition: a read-only tool executes end-to-end; mutating tools cannot execute without a production approval evaluator.

## Phase 1 — Kairoseth native control channel

- Define bridge identity and installation registration contract
- Define outbound-only session lifecycle
- Add tenant + installation scoping
- Add short-lived authenticated bridge credentials
- Add signed approval decision verifier
- Bind approval to tool, correlation ID and action fingerprint
- Add heartbeat, readiness and capability advertisement
- Add reconnect/backoff behavior
- Add sanitized audit event delivery

Exit condition: a local bridge can establish an outbound authenticated session and safely execute an approved WRITE operation.

## Phase 2 — Connector SDK + Generic REST/Webhook

- Extract Connector SDK
- Add JSON-schema-style input/output descriptors
- Add connector capability manifest
- Add secret requirement descriptors without exposing values
- Add timeout, retry and idempotency hooks
- Implement Generic REST connector
- Implement webhook trigger/output adapter
- Add response redaction rules

Exit condition: an external SaaS API can be exposed as normalized bridge tools without custom runtime code.

## Phase 3 — MCP

- Implement MCP server adapter over the normalized registry
- Map tool schemas and descriptions
- Preserve risk metadata internally
- Route mutating MCP tool calls through the same approval engine
- Add MCP interoperability tests

Exit condition: an MCP-compatible agent can discover and invoke Agent Bridge tools without bypassing Kairoseth policy.

## Phase 4 — First business connectors

### WooCommerce

Initial tool set:

- list/get orders — READ
- list/get products and stock — READ
- update order metadata/status — WRITE
- update stock/product data — WRITE

### MySQL

Initial model:

- parameterized read profiles — READ
- explicitly declared mutation profiles — WRITE/CRITICAL
- no arbitrary SQL by default

### Files

Initial model:

- list/read allowed roots — READ
- create/update allowed roots — WRITE
- delete/move sensitive paths — CRITICAL

Exit condition: the first Kairoseth products can consume real business-system connectors through the same bridge contract.

## Phase 5 — A2A + agent interoperability

- Implement A2A skill adapter
- Add agent identity mapping
- Add delegated authorization model
- Add invocation provenance
- Add cross-agent correlation and audit

Exit condition: MCP, A2A and Kairoseth-native callers share one execution and policy core.

## Phase 6 — Production hardening

- Encrypted temporary local queue
- Replay protection and idempotency store
- Payload/rate limits
- Circuit breakers
- Connector health isolation
- Credential rotation hooks
- Signed releases
- SBOM
- Security scanning
- Threat model
- Failure/rollback drills
- Installation/update strategy for local bridge
- Observability dashboards in Kairoseth Platform

Exit condition: production-ready bridge runtime for cloud, hybrid and on-premises installations.

## Product integration order

The bridge is transversal infrastructure. Initial consumers should integrate through contracts rather than forks:

1. IA Empleado
2. CRA/Product Security workflows
3. VeriFactu/ERP connector scenarios where the bridge is only the transport/integration edge
4. DeCA connector scenarios
5. Future Kairoseth Extensions and customer-specific agents

This order can change based on which integration provides the fastest real end-to-end proof, but no consumer should own a private copy of the bridge runtime.

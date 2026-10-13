# Kairoseth Agent Bridge — Architecture

## 1. Purpose

Kairoseth Agent Bridge is the universal execution and integration layer between AI agents and business systems.

Its responsibility is to normalize tools, enforce execution policy, hand sensitive actions to the Kairoseth approval plane, execute approved operations, and emit auditable lifecycle events.

It is deliberately separated from product logic such as IA Empleado, CRA OS, VeriFactu or DeCA.

## 2. System boundary

### Kairoseth Platform — control plane

Kairoseth Platform remains authoritative for:

- organizations and tenants;
- installations and bridge registrations;
- connector catalog and configuration metadata;
- agent identities and permissions;
- policies and approval workflows;
- credential/secret metadata and rotation orchestration;
- audit visualization and monitoring;
- product entitlements and lifecycle.

The Platform continues to run on the established Kairoseth infrastructure. Agent Bridge must not create a parallel control plane or a second customer/tenant database.

### Agent Bridge — execution/data plane

Agent Bridge owns:

- tool registration and discovery;
- normalized invocation contracts;
- local policy enforcement points;
- execution gating;
- connector runtime;
- protocol adapters;
- outbound control channel;
- temporary delivery queue where required;
- sanitized audit/event emission;
- health/readiness information.

## 3. Deployment modes

### Local / on-premises

Preferred when the target ERP, database, NAS, filesystem or internal API is not publicly reachable.

The local bridge:

1. is installed inside the customer network;
2. establishes an outbound authenticated connection to Kairoseth;
3. receives only authorized work for its installation;
4. invokes local connectors;
5. returns sanitized results and audit events.

No inbound firewall port should be required by default.

### Hybrid

The Kairoseth control plane remains hosted while execution takes place locally. This is the default model for private customer systems.

### Hosted

Connectors that target public SaaS APIs can run in a hosted bridge runtime where appropriate.

## 4. Invocation lifecycle

```text
Agent
  |
  v
Kairoseth Platform / Agent Router
  |
  | normalized invocation
  v
Agent Bridge
  |
  +--> Tool Registry
  |
  +--> Policy Evaluator
  |       |
  |       +--> ALLOW
  |       +--> DENY
  |       +--> REQUIRE_APPROVAL --> Kairoseth approval workflow
  |
  +--> Connector / Tool execution
  |
  +--> Sanitized result
  |
  +--> Audit events
  v
Kairoseth Platform
```

## 5. Risk model

Every tool declares one risk class:

### READ

Read-only operations. The bootstrap secure-default policy allows these operations.

Examples: list orders, query stock, read a file metadata record, fetch a CRM contact.

### WRITE

Mutating operations. Secure default requires an explicit approval decision from the Kairoseth control plane.

Examples: update an order, create a CRM task, write a file, update a record.

### CRITICAL

High-impact or sensitive operations. These always require explicit policy/approval and may later add stronger controls such as step-up authentication or dual approval.

Examples: destructive operations, financial actions, bulk mutations, permission changes.

## 6. Approval trust boundary

The bridge must never treat the mere presence of an `approvalToken` as proof of approval.

A production approval path must verify a signed or otherwise authenticated decision bound to at least:

- tenant;
- installation;
- tool ID;
- correlation ID / invocation ID;
- requested action fingerprint;
- expiration;
- decision.

Until that verifier exists, the bootstrap policy returns `REQUIRE_APPROVAL` for WRITE and CRITICAL operations.

## 7. Protocol strategy

The same normalized tool model is exposed through adapters instead of duplicating connector logic.

Planned protocol adapters:

- Kairoseth native bridge protocol;
- REST / Webhooks;
- MCP server/tools;
- A2A skills.

A connector must not implement protocol-specific authorization itself unless the remote system requires it. Bridge-level identity, policy, approval and audit remain centralized.

## 8. Connector SDK

Connectors will implement a common SDK contract describing:

- connector ID and version;
- capabilities;
- tools;
- risk level per tool;
- input/output schemas;
- health checks;
- credential requirements;
- optional idempotency support;
- timeout/retry constraints;
- redaction metadata.

Initial MVP targets:

1. Generic REST / Webhook
2. WooCommerce
3. MySQL
4. Files

## 9. Security principles

- outbound-only local connectivity by default;
- fail closed for unknown or unauthorized mutations;
- least privilege per connector credential;
- no raw secret logging;
- no raw credential echo in results;
- correlation IDs for every invocation;
- deterministic risk classification per registered tool;
- explicit tenant/installation scope;
- bounded timeouts and payload sizes;
- replay/idempotency protections for mutating actions;
- auditable policy and execution lifecycle.

## 10. Storage

The bridge is not the system of record for Kairoseth tenants or products.

Local persistence, when required, is limited to runtime concerns such as an encrypted/temporary delivery queue, replay protection and short-lived operational state. The control plane remains authoritative.

## 11. Repository shape

Bootstrap starts intentionally small:

```text
src/
  core/
    contracts.ts
    policy.ts
    registry.ts
    audit.ts
  runtime/
    bridge-runtime.ts
  index.ts
tests/
  core/
docs/
```

As contracts stabilize, the repository can split into packages for the runtime, Connector SDK, protocol adapters and official connectors without changing the trust boundary above.

## 12. Non-goals

Agent Bridge will not:

- become a second Kairoseth Platform;
- own customer billing or entitlements;
- reimplement IA Empleado, VeriFactu, DeCA or CRA OS business logic;
- become an independent fiscal authority;
- require inbound ports for normal local installations;
- persist secrets in source control;
- bypass Platform approval for sensitive actions.

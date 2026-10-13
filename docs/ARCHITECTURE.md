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

The Platform continues to run inside the existing Kairoseth structure at `kairoseth.com`. Agent Bridge must reuse that structure and must not create a parallel control plane, customer dashboard or second tenant database.

Agent Bridge is therefore surfaced as a capability of Kairoseth Platform, while its runtime may execute elsewhere depending on the customer environment.

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

## 3. Deployment model

The runtime is adaptive: where it executes depends on where the customer system lives and how it can be reached safely.

### Hosted

Used when the target system is safely reachable through a public API.

Typical targets:

- SaaS ERP/CRM;
- public APIs;
- cloud services;
- some WordPress/PrestaShop deployments.

No customer-local runtime is required when local network access is unnecessary.

### Local / on-premises

Preferred when the target ERP, database, NAS, filesystem, internal API or custom software is not publicly reachable.

The local bridge:

1. is installed inside the customer network;
2. establishes an outbound authenticated connection to Kairoseth;
3. receives only authorized work for its installation;
4. invokes local connectors;
5. returns sanitized results and audit events.

No inbound firewall port should be required by default.

### Hybrid

The Kairoseth control plane remains hosted at `kairoseth.com` while execution takes place locally. This is the default model for private customer systems.

### Embedded connector

Some systems are better served by a native extension, such as a WordPress/WooCommerce plugin or a PrestaShop module.

These adapters still follow the same Agent Bridge contracts, policies, signed approvals and audit model; they are packaging choices, not separate architectures.

### Runtime examples

- WordPress / WooCommerce → connector plugin and/or lightweight runtime.
- PrestaShop → module and/or sidecar runtime.
- SaaS ERP / CRM → hosted runtime through API/OAuth.
- On-prem ERP / CRM → Docker or OS service inside the customer network.
- MySQL / PostgreSQL / SQL Server → local runtime close to the database.
- NAS / files → local runtime scoped to allowed roots.
- Custom software → REST, webhook, Connector SDK, MCP, A2A or custom adapter.

The normalized Agent Bridge tool model remains the same in every case.

Detailed deployment rules are documented in `docs/RUNTIME_DEPLOYMENT.md`.

## 4. Invocation lifecycle

```text
Agent
  |
  v
Kairoseth Platform / Agent Router
  |
  | normalized invocation
  v
Agent Bridge Runtime
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

Read-only operations. The secure-default policy allows these operations.

Examples: list orders, query stock, read file metadata, fetch a CRM contact.

### WRITE

Mutating operations. These require an explicit authenticated approval decision from the Kairoseth control plane when governed by the signed approval policy.

Examples: update an order, create a CRM task, write a file, update a record.

### CRITICAL

High-impact or sensitive operations. These require explicit policy/approval and may later add stronger controls such as step-up authentication or dual approval.

Examples: destructive operations, financial actions, bulk mutations, permission changes.

## 6. Approval trust boundary

The bridge never treats the mere presence of an `approvalToken` as proof of approval.

The current signed approval path binds the decision to:

- tenant;
- installation;
- tool ID;
- correlation ID / invocation ID;
- requested action fingerprint;
- expiration;
- decision.

The action fingerprint also covers the exact invocation input, preventing a valid approval from being reused for a modified action.

See `docs/APPROVAL_PROTOCOL.md`.

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

Local persistence, when required, is limited to runtime concerns such as an encrypted/temporary delivery queue, replay protection and short-lived operational state. The Kairoseth control plane remains authoritative.

## 11. Repository shape

The repository contains the reusable execution/runtime, security primitives, Connector SDK foundations, protocol adapters and official connectors.

Customer-side packages are deployment artifacts of this repository, for example:

```text
Agent Bridge Core
├── Hosted runtime
├── Docker runtime
├── Linux service
├── Windows service
├── WordPress connector
├── PrestaShop connector
└── Custom SDK connector
```

These packaging variants must not fork the security and policy core.

## 12. Non-goals

Agent Bridge will not:

- become a second Kairoseth Platform;
- rebuild authentication, tenants, customer administration or monitoring already owned by Kairoseth Platform;
- own customer billing or entitlements;
- reimplement IA Empleado, VeriFactu, DeCA or CRA OS business logic;
- become an independent fiscal authority;
- require inbound ports for normal local installations;
- persist secrets in source control;
- bypass Platform approval for sensitive actions.

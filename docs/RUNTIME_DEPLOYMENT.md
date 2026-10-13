# Kairoseth Agent Bridge — Runtime Deployment Model

## Decision

Kairoseth Agent Bridge is managed from the existing Kairoseth Platform at `kairoseth.com`, but its runtime is deployed according to the customer's technical environment.

There is no requirement for every customer to install the same executable in the same way.

The platform layer is shared; the execution layer adapts.

## What already exists in Kairoseth

Agent Bridge must reuse the existing Kairoseth Platform structure instead of creating a parallel product administration stack.

Kairoseth Platform remains responsible for:

- authentication and user access;
- organizations / tenants;
- installations;
- agent identities and permissions;
- connector catalog and configuration metadata;
- policies and approvals;
- audit and monitoring views;
- product lifecycle and entitlements;
- shared platform infrastructure.

Agent Bridge adds the execution and integration capabilities required to reach customer systems.

This means the project does **not** need to rebuild a second dashboard, customer database, tenant model or control plane.

## Logical architecture

```text
kairoseth.com
│
├── Kairoseth Platform
│   ├── Authentication
│   ├── Organizations / tenants
│   ├── Agents
│   ├── Extensions
│   ├── Integrations
│   └── Agent Bridge
│       ├── Installations
│       ├── Connectors
│       ├── Tools / Skills
│       ├── Policies
│       ├── Approvals
│       ├── Audit
│       └── Monitoring
│
└── Kairoseth control plane / API
        │
        │ authenticated outbound session when required
        ▼
  Agent Bridge Runtime
        │
        └── Customer systems
```

## Runtime principle

The runtime is the execution component that has access to the target system.

Its placement depends on where that system lives and how it can be reached safely.

All deployment modes expose the same normalized Kairoseth tool contract, so agents do not need to know whether the underlying system is WordPress, PrestaShop, an ERP, a CRM, a database, a NAS or custom software.

## Deployment matrix

### WordPress / WooCommerce

Possible deployment:

- Kairoseth WordPress/WooCommerce connector plugin;
- optional lightweight local/sidecar runtime when the hosting or use case requires it;
- hosted runtime when the WordPress REST/API surface is sufficient and secure.

Typical tools:

- orders.list
- orders.get
- orders.update
- products.list
- stock.get
- stock.update

### PrestaShop

Possible deployment:

- PrestaShop module/connector;
- sidecar/local runtime where direct local access is required;
- hosted runtime when the public API/module endpoint is sufficient.

### ERP / CRM SaaS

Examples include cloud systems with supported APIs.

Preferred deployment:

- hosted Agent Bridge runtime;
- API/OAuth connector;
- no customer-local installation unless a private network restriction requires it.

### ERP / CRM on-premises

Preferred deployment:

- local Agent Bridge runtime inside the customer network;
- Docker container or operating-system service;
- outbound-only authenticated connection to Kairoseth by default;
- no public exposure of the ERP/CRM required.

### Database systems

Examples:

- MySQL
- PostgreSQL
- SQL Server
- other supported databases

Preferred deployment when the database is private:

- local runtime near the database;
- database remains inaccessible from the public Internet;
- connector receives least-privilege credentials;
- arbitrary SQL is not enabled by default.

### Files / NAS / shared folders

Preferred deployment:

- local runtime with access only to explicitly allowed roots;
- path-level permission controls;
- read/write/delete risk classification applied by tool.

### Customer-owned custom software

Possible integration methods:

- REST API;
- webhooks;
- Kairoseth Connector SDK;
- MCP adapter;
- A2A adapter;
- custom connector running in the standard bridge runtime.

The customer does not need to rewrite the application around Kairoseth.

### Public SaaS / public APIs

Preferred deployment:

- hosted Agent Bridge runtime;
- no customer installation when local network access is unnecessary.

## Deployment modes

### Hosted

Kairoseth runs the runtime because the target system is safely reachable through a public API.

Best suited for:

- SaaS products;
- public APIs;
- cloud services;
- some WordPress/PrestaShop installations.

### Local / on-premises

The runtime runs inside the customer's environment.

Best suited for:

- private ERP/CRM;
- local databases;
- NAS/filesystems;
- internal APIs;
- legacy systems;
- software that must not be exposed publicly.

The default communication model is outbound-only from the customer network to Kairoseth.

### Hybrid

Kairoseth Platform remains hosted while execution occurs partly or fully inside the customer environment.

This is expected to be the common model for companies with private internal systems.

### Embedded connector

A connector can be packaged as a native extension for a product such as WordPress or PrestaShop while still following the Agent Bridge contracts and security model.

The embedded connector is not a separate architecture; it is another deployment form of the same integration layer.

## One runtime core, multiple packaging options

We should avoid creating independent runtimes per product.

The target model is:

```text
Agent Bridge Core
│
├── Hosted package
├── Docker package
├── Linux service
├── Windows service
├── WordPress connector
├── PrestaShop connector
└── Custom SDK connector
```

The common core provides:

- normalized tools;
- identity and installation scope;
- policy enforcement;
- signed approvals;
- audit lifecycle;
- connector registration;
- control-channel contracts;
- health/capability reporting.

Product-specific packages only provide the adapter needed to reach the target system.

## Normalization goal

The main product value is that Kairoseth agents consume capabilities, not vendor-specific implementation details.

For example, an agent can request a stock update through a normalized tool even if the real implementation is backed by:

- WooCommerce;
- PrestaShop;
- an ERP;
- a custom database;
- proprietary customer software.

The connector translates the normalized Kairoseth invocation into the target system's native operation.

## Security consequence

Runtime placement is a security decision as well as a deployment decision.

When a target system is private, the preferred architecture is to move the runtime close to the data instead of exposing the data source to Kairoseth or to the Internet.

Therefore:

- private systems stay private by default;
- inbound firewall openings are avoided by default;
- credentials remain scoped to the connector;
- high-impact actions still pass through Kairoseth policy and approval controls regardless of deployment mode.

## Product boundary

Commercially and operationally, Agent Bridge is a capability of Kairoseth Platform and is surfaced through `kairoseth.com`.

Technically, the `kairoseth-agent-bridge` repository contains the reusable execution/runtime, SDK, protocol and connector foundations.

Customer-side runtime packages are deployment artifacts of that repository, not separate Kairoseth products.

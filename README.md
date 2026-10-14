# Agent Bridge

**Technical runtime behind Integración de agentes de IA / AI Integration in Kairoseth Platform.**

Agent Bridge is the execution and integration layer that safely exposes business systems to AI agents through a normalized tool contract.

## Product identity boundary

The canonical ecosystem naming policy lives in `Emmakex/kairoseth-platform/docs/COMMERCIAL_PRODUCT_NAMING.md`.

- Technical identity: `agent-bridge`
- Technical component/runtime: `Agent Bridge`
- Commercial name ES: **Integración de agentes de IA**
- Commercial name EN: **AI Integration**
- Umbrella brand: **Kairoseth**

Customer-facing surfaces use the localized commercial name. Engineering code, packages, protocols, logs and architecture may keep `Agent Bridge` when they refer to the technical component. A commercial rename does not change repository/package identity, routes, APIs, RBAC, tool IDs, connector IDs, persisted data or integration contracts by itself.

See `docs/PRODUCT_IDENTITY.md` and `docs/I18N.md`.

## Architecture boundary

This repository is **not** a second Kairoseth Platform.

- **Kairoseth Platform** remains the control plane: organizations/tenants, installations, policies, approvals, audit views, connector catalog, credentials metadata and product management.
- **Agent Bridge** is the execution/data plane: local or hosted bridge runtime, tool gateway, protocol adapters, connector SDK, policy enforcement points, approval hand-off and audit/event emission.
- Customer systems remain behind the bridge whenever possible. Local deployments use outbound-only connectivity by default.
- No product-specific authority belongs here. VeriFactu, DeCA, CRA/Product Security and IA Empleado consume the bridge through explicit contracts instead of being reimplemented inside it.

## Core protocols

- REST / Webhook gateway
- MCP tools/server adapter
- A2A skill adapter
- Kairoseth-native bridge protocol

## Security model

Every operation is classified before execution:

- `READ` — read-only access
- `WRITE` — mutating action
- `CRITICAL` — sensitive or high-impact action requiring explicit policy/approval

The bridge never logs raw secrets. Approval, policy and audit decisions are traceable by correlation ID.

## Runtime model

The same Agent Bridge core can be deployed as hosted, local/on-premises, hybrid or embedded packaging depending on the customer system. Runtime identity and the authoritative installation binding persist across restarts; short-lived control-session credentials remain ephemeral.

Local runtimes establish outbound authenticated sessions with Kairoseth Platform, advertise readiness/capabilities, renew sessions before expiry and reconnect using bounded exponential backoff.

The control channel includes signed approvals, single-use approval nonces, chained approval-key rotation, crash-safe command deduplication, sanitized durable audit delivery, runtime inventory/health reporting and scheduled operational snapshots.

## Connector SDK

The shared Connector SDK is used by REST APIs, WooCommerce, PrestaShop, ERP/CRM adapters, databases and filesystem connectors.

Connector definitions declare capabilities, non-secret configuration schemas, credential requirements, normalized tools, risk, input/output schemas, health checks and safe timeout/retry/idempotency behavior. Credential values are obtained only at execution time through a secret-provider abstraction.

## Generic REST

The Generic REST implementation maps predeclared REST operations into Bridge tools. It supports Bearer/Basic/API-key authentication through `ConnectorSecretProvider`, controlled path/query/body mapping, response-size bounds and sensitive response-field redaction.

By default Generic REST requires HTTPS, blocks local/private destinations, never follows redirects and keeps `baseUrl` outside agent-controlled tool input. Controlled on-premise deployments can explicitly enable HTTP/private-network access.

## Initial business connectors

- Generic REST / Webhook
- WooCommerce
- PrestaShop
- MySQL
- Files / local filesystem adapter

More connectors are added through the Connector SDK without forking the execution/security core.

## Repository direction

The project is TypeScript-first and Node.js-based. The runtime is designed to be container-friendly and capable of running hosted, hybrid or on-premises without requiring inbound ports for normal local installations.

Core documentation:

- `docs/ARCHITECTURE.md`
- `docs/ROADMAP.md`
- `docs/PRODUCT_IDENTITY.md`
- `docs/I18N.md`
- `docs/RUNTIME_DEPLOYMENT.md`
- `docs/ENROLLMENT_PROTOCOL.md`
- `docs/CONTROL_SESSION_PROTOCOL.md`
- `docs/SESSION_RESILIENCE.md`
- `docs/COMMAND_DELIVERY_PROTOCOL.md`
- `docs/APPROVAL_PROTOCOL.md`
- `docs/APPROVAL_KEY_ROTATION.md`
- `docs/AUDIT_DELIVERY_PROTOCOL.md`
- `docs/CONNECTOR_SDK.md`
- `docs/GENERIC_REST_CONNECTOR.md`

## Status

Phases 0–5 are complete. Phase 6 — Production hardening — is in progress, including release integrity, supply-chain/security hardening, packaging, observability and ES/EN installer/operator surfaces.

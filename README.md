# Kairoseth Agent Bridge

**Universal Agent Integration Gateway for Kairoseth.**

Kairoseth Agent Bridge is the runtime and integration layer that safely exposes business systems to AI agents through a normalized tool contract.

## Architecture boundary

This repository is **not** a second Kairoseth Platform.

- **Kairoseth Platform** remains the control plane: organizations/tenants, installations, policies, approvals, audit views, connector catalog, credentials metadata and product management.
- **Kairoseth Agent Bridge** is the execution/data plane: local or hosted bridge runtime, tool gateway, protocol adapters, connector SDK, policy enforcement points, approval hand-off and audit/event emission.
- Customer systems remain behind the bridge whenever possible. Local deployments use outbound-only connectivity by default.
- No product-specific authority belongs here. VeriFactu, DeCA, CRA OS and IA Empleado consume the bridge through explicit contracts instead of being reimplemented inside it.

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

The Phase 1 control channel includes signed approvals, single-use approval nonces, chained approval-key rotation, crash-safe command deduplication and sanitized durable audit delivery.

## Connector SDK

Phase 2 introduces the shared Connector SDK used by REST APIs, WooCommerce, PrestaShop, ERP/CRM adapters, databases and filesystem connectors.

Connector definitions declare capabilities, non-secret configuration schemas, credential requirements, normalized tools, risk, input/output schemas, health checks and safe timeout/retry/idempotency behavior. Credential values are obtained only at execution time through a secret-provider abstraction.

## Generic REST

The first Connector SDK implementation maps predeclared REST operations into Bridge tools. It supports Bearer/Basic/API-key authentication through `ConnectorSecretProvider`, controlled path/query/body mapping, response-size bounds and sensitive response-field redaction.

By default Generic REST requires HTTPS, blocks local/private destinations, never follows redirects and keeps `baseUrl` outside agent-controlled tool input. Controlled on-premise deployments can explicitly enable HTTP/private-network access.

## Initial MVP connectors

- Generic REST / Webhook
- WooCommerce
- MySQL
- Files / local filesystem adapter

More connectors will be added through the Connector SDK.

## Repository direction

The project is TypeScript-first and Node.js-based. The runtime is designed to be container-friendly and capable of running hosted, hybrid or on-premises without requiring inbound ports for normal local installations.

Core documentation:

- `docs/ARCHITECTURE.md`
- `docs/ROADMAP.md`
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

Phase 0 and Phase 1 are complete. Phase 2 — Connector SDK + Generic REST/Webhook — is in progress; Connector SDK and Generic REST are implemented, and the Webhook adapter is next.

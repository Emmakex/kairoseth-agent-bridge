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
- `docs/APPROVAL_PROTOCOL.md`

## Status

Phase 0 is complete. Phase 1 — Kairoseth native control channel — is in progress, with installation identity, enrollment, short-lived authenticated sessions, heartbeat/capability advertisement and runtime session resilience implemented.

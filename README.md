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

## Initial MVP connectors

- Generic REST / Webhook
- WooCommerce
- MySQL
- Files / local filesystem adapter

More connectors will be added through the Connector SDK.

## Repository direction

The project is TypeScript-first and Node.js-based. The runtime will be container-friendly and capable of running cloud, hybrid or on-premises without requiring inbound ports for local installations.

See `docs/ARCHITECTURE.md` and `docs/ROADMAP.md` once the bootstrap PR lands.

## Status

Bootstrap in progress.

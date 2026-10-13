# Kairoseth Agent Bridge — Signed Approval Protocol v1

## Purpose

Mutating bridge operations must not execute merely because an agent supplies an arbitrary approval marker.

Version 1 defines a compact signed approval token that binds a Kairoseth Platform decision to one exact bridge invocation.

## Token format

```text
kab1.<key-id>.<payload>.<signature>
```

All three variable segments use unpadded base64url encoding.

- `key-id`: UTF-8 signing key identifier.
- `payload`: UTF-8 canonical JSON approval payload.
- `signature`: Ed25519 signature.

The signature input is the exact ASCII string:

```text
kab1.<key-id>.<payload>
```

The bridge never signs approvals. It only verifies decisions produced by the trusted Kairoseth control plane.

## Payload

The decoded payload is canonical JSON with this logical shape:

```json
{
  "version": "kab.approval.v1",
  "decision": "ALLOW",
  "tenantId": "tenant-1",
  "installationId": "installation-1",
  "toolId": "orders.update",
  "correlationId": "corr-1",
  "actionFingerprint": "...",
  "issuedAt": "2026-10-13T13:29:00.000Z",
  "expiresAt": "2026-10-13T13:31:00.000Z",
  "nonce": "..."
}
```

`decision` is either `ALLOW` or `DENY`.

## Action fingerprint

The approval is bound to the exact action, not only the tool name.

The bridge computes canonical JSON for:

```json
{
  "version": "kab.action.v1",
  "tenantId": "...",
  "installationId": "...",
  "toolId": "...",
  "correlationId": "...",
  "input": {}
}
```

It then calculates:

```text
SHA-256(canonical-json) -> base64url
```

That value must equal `actionFingerprint` in the signed approval payload.

Changing any protected field — including a single value inside `input` — invalidates the approval for that invocation.

## Canonical JSON

The bridge canonical encoder currently applies these rules:

- JSON-compatible values only;
- object keys ordered lexicographically by code-unit comparison;
- undefined object properties omitted;
- array order preserved;
- non-finite numbers rejected;
- no locale-sensitive key sorting.

Kairoseth Platform must produce the same canonical representation when calculating fingerprints and signing approval payloads.

## Verification sequence

For `WRITE` and `CRITICAL` tools the bridge performs these checks before execution:

1. Tenant and installation scope exist.
2. An approval token exists.
3. Token structure is valid and bounded in size.
4. `key-id` resolves to a trusted Platform public key.
5. Ed25519 signature verifies.
6. Tenant matches.
7. Installation matches.
8. Tool ID matches.
9. Correlation ID matches.
10. Action fingerprint matches the exact invocation input.
11. `issuedAt` and `expiresAt` are valid.
12. The token is not too far in the future.
13. The token is not expired.
14. `DENY` remains denied; only a valid `ALLOW` reaches execution.

Any verification failure fails closed.

## Key trust

The bridge receives trusted public verification keys through Kairoseth-controlled configuration/session bootstrapping.

Private approval signing keys belong only to the Kairoseth control plane and must never be distributed to bridge installations.

Key rotation is supported by `key-id`: multiple public keys may be trusted during a controlled rotation window.

## Replay protection

Version 1 already includes a signed `nonce`, but persistent one-time replay enforcement is intentionally not implemented in this microphase.

Before production approval execution is considered complete, Phase 1 must add a bounded replay/idempotency store so a valid mutating approval cannot be consumed more times than its policy permits.

## Clock skew

The verifier currently supports a bounded clock-skew allowance. The default implementation uses 30 seconds.

Production bridge installations must maintain reasonably synchronized clocks.

## Security boundary

A valid signature proves that the trusted signing key approved or denied the represented payload. It does not replace:

- agent authorization in Kairoseth Platform;
- connector least-privilege credentials;
- tenant/installation isolation;
- replay protection;
- connector-side validation;
- audit logging.

Those controls remain separate layers.

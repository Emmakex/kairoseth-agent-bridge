# Kairoseth Agent Bridge — Signed Approval Protocol v1

## Purpose

Mutating bridge operations must not execute merely because an agent supplies an arbitrary approval marker.

Version 1 defines a compact signed approval token that binds a Kairoseth Platform decision to one exact bridge invocation and enforces one-time consumption for valid `ALLOW` decisions.

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

## Verification and consumption sequence

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
14. `DENY` remains denied.
15. For a valid `ALLOW`, the signed nonce is atomically consumed in the replay store.
16. If the nonce already exists, the action is denied.
17. If replay protection is unavailable, the action is denied.
18. Only a newly consumed valid `ALLOW` reaches execution.

Any verification or replay-protection failure fails closed.

## Key trust

The bridge receives trusted public verification keys through Kairoseth-controlled configuration/session bootstrapping.

Private approval signing keys belong only to the Kairoseth control plane and must never be distributed to bridge installations.

Key rotation is supported by `key-id`: multiple public keys may be trusted during a controlled rotation window.

The dynamic Platform-to-runtime rotation channel remains a separate Phase 1 concern.

## Replay protection

Every approval carries a signed `nonce`.

A valid `ALLOW` nonce is single-use. After signature, scope, fingerprint and lifetime validation, the bridge writes a durable replay record before returning `ALLOW` to the execution runtime.

The record contains only replay-control metadata:

- nonce;
- tenant and installation;
- tool ID;
- correlation ID;
- action fingerprint;
- consumption timestamp;
- retention timestamp.

It does **not** persist the approval token itself.

### Different command IDs do not bypass replay protection

Command-level deduplication and approval-level replay protection are separate controls.

Even if the same valid signed approval is placed inside a second command with a different `commandId`, the approval nonce has already been consumed and the second mutation is denied.

### Persistence

The repository provides:

- `InMemoryApprovalReplayStore` for tests/composition;
- `FileApprovalReplayStore` as the baseline persistent runtime implementation.

The filesystem implementation uses versioned state, atomic temporary-file + rename writes and restrictive filesystem permissions where supported.

Replay records survive runtime restarts.

### Concurrency

The built-in filesystem store serializes consume operations within the runtime process so concurrent attempts for one nonce produce at most one successful consumption.

Deployment packaging must run one authoritative writer for a given local replay file. Multi-process/clustered deployments should replace this store with a transactional shared backend that implements the same atomic consume contract.

### Retention and pruning

Replay records are retained beyond approval expiry for a bounded safety window and can be pruned after `retainUntil`.

The default policy adds 24 hours beyond the later of consumption time or approval expiry.

### Failure behavior

Replay-store failure is security-sensitive. The policy fails closed:

```text
replay store unavailable -> DENY
```

A signed `DENY` never grants execution and therefore does not need to consume execution permission.

## Approval consumption and execution failure

The nonce is consumed **before** a valid mutating action is released to the tool runtime.

This means a connector/tool failure after approval consumption does not make the same approval reusable. A retry that requires a new execution must receive a new Platform approval/nonce unless a higher-level workflow explicitly reconciles the previous attempt.

This conservative behavior prevents a failure path from becoming a replay path.

## Clock skew

The verifier supports a bounded clock-skew allowance. The default implementation uses 30 seconds.

Production bridge installations must maintain reasonably synchronized clocks.

## Security boundary

A valid signature plus a newly consumed nonce proves that the trusted signing key approved the represented action and that the approval has not already been used by this runtime trust domain. It does not replace:

- agent authorization in Kairoseth Platform;
- connector least-privilege credentials;
- tenant/installation isolation;
- command delivery deduplication;
- connector-side validation;
- audit logging;
- transactional shared replay storage for clustered runtimes.

Those controls remain separate layers.

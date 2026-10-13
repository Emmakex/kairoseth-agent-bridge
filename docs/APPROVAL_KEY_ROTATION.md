# Kairoseth Agent Bridge — Approval Key Rotation Protocol v1

## Purpose

Signed approvals are only useful if a bridge runtime can update the set of trusted Kairoseth Platform signing keys without accepting an attacker-controlled replacement.

This protocol provides a chained, rollback-resistant rotation model.

## Bootstrap trust

The first trusted approval public keys arrive inside the Platform-authoritative `InstallationBinding` created during enrollment.

Those keys become approval keyset generation `0`.

No runtime-generated key is automatically trusted as a Platform approval signing key.

## Keyset payload

A rotated keyset uses:

```text
kab.approval-keyset.v1
```

Logical payload:

```json
{
  "version": "kab.approval-keyset.v1",
  "tenantId": "tenant-...",
  "installationId": "installation-...",
  "bridgeInstanceId": "bridge-...",
  "generation": 1,
  "keys": [
    {
      "keyId": "approval-key-2026-10",
      "publicKeyPem": "-----BEGIN PUBLIC KEY-----...",
      "notBefore": "optional ISO timestamp",
      "notAfter": "optional ISO timestamp"
    }
  ],
  "issuedAt": "..."
}
```

The signed envelope adds:

```text
signerKeyId
signature
```

The Ed25519 signature covers canonical JSON of the full payload.

## Chain of trust

A keyset update is accepted only when `signerKeyId` identifies a key that is already present and active in the **current** trusted keyset.

Example safe rotation:

```text
generation 0: [old]
       |
       | signed by old
       v
generation 1: [old, new]
       |
       | signed by new
       v
generation 2: [new]
```

This overlap lets the new key become trusted before the old key is removed.

An untrusted key cannot introduce itself.

## Scope binding

Every keyset payload is bound to:

- tenant;
- installation;
- bridge instance.

A signed keyset for one installation cannot be copied into another runtime.

## Generation / rollback protection

The persisted state tracks a monotonically increasing `generation`.

An update must have a generation strictly greater than the current one. Older or equal generations are rejected.

This prevents a valid historical keyset from rolling the runtime back to retired keys.

## Key validity windows

Each trusted public key can optionally declare:

- `notBefore`;
- `notAfter`.

The runtime only resolves a key for approval verification while it is active.

A rotation update must leave at least one key active at application time. This prevents applying a signed but operationally unusable keyset that would immediately lock out all approval validation.

## Persistence

The repository provides:

- `InMemoryApprovalKeySetStore`;
- `FileApprovalKeySetStore`.

The file store persists the latest accepted generation using atomic temporary-file + rename writes and restrictive filesystem permissions where supported.

After restart the runtime loads the persisted generation instead of falling back to enrollment generation `0`. This is necessary for rollback resistance across restarts.

## Control-channel synchronization

`ApprovalKeySetSyncClient` uses the active short-lived control session to ask Kairoseth Platform whether a newer generation exists.

It sends:

- session access token as transport authentication;
- current session ID;
- current keyset generation.

If Platform returns no update, state is unchanged.

If Platform returns a signed update, the runtime still performs the full signature and chain-of-trust validation. Transport authentication alone is not sufficient to replace approval trust keys.

## Integration with signed approval verification

`ApprovalKeySetManager.resolvePublicKey(keyId)` implements the public-key resolver contract consumed by `SignedApprovalVerifier`.

Recommended composition:

```text
InstallationBinding
      |
      v
ApprovalKeySetManager
      |
      +--> sync signed rotations
      |
      +--> resolvePublicKey(keyId)
                  |
                  v
        SignedApprovalVerifier
                  |
                  v
        SignedApprovalPolicyEvaluator
```

This means newly trusted approval signing keys become usable without rebuilding the runtime or changing connector code.

## Failure behavior

Reject the update when any of these conditions holds:

- unsupported keyset version;
- wrong tenant/installation/bridge scope;
- non-increasing generation;
- invalid or future `issuedAt` beyond clock-skew allowance;
- signer missing from current trusted keys;
- signer outside validity window;
- invalid Ed25519 signature;
- malformed or duplicate key IDs;
- invalid public key material;
- invalid validity window;
- no active key would remain.

The previously persisted trusted keyset remains authoritative after a rejected update.

## Clustered deployments

The baseline file store is suitable for a single authoritative runtime process/state directory.

Clustered or multi-writer bridge runtimes should use a shared transactional keyset store with compare-and-swap or equivalent generation enforcement so competing updates cannot overwrite newer state.

## Remaining control-channel work

After key rotation, the principal remaining Phase 1 transport feature is sanitized audit event delivery to Kairoseth Platform.

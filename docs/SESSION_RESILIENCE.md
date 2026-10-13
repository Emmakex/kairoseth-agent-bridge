# Kairoseth Agent Bridge — Runtime State and Session Resilience

## Purpose

This microphase makes an enrolled bridge runtime survive routine restarts and transient network failures without repeating enrollment.

The runtime persists its long-lived identity and authoritative installation binding, while operational session credentials remain short-lived and in memory.

## Persistent runtime state

Two different records are persisted:

### Bridge identity

`kab.identity.v1`

Contains:

- stable `bridgeInstanceId`;
- Ed25519 public key;
- Ed25519 private key;
- public-key-derived `keyId`;
- creation timestamp.

The repository now includes `FileBridgeIdentityStore`, which uses an atomic temporary-file + rename pattern and creates state with restrictive permissions.

### Installation binding

`kab.installation-binding.v1`

Contains the Platform-authoritative relationship between:

- tenant;
- installation;
- bridge instance;
- bridge key;
- trusted approval verification keys.

The repository includes `FileInstallationBindingStore` plus `InstallationBindingManager`, which validates that a persisted binding still belongs to the current bridge identity before returning it.

A copied or stale binding for another bridge/key is rejected.

## Filesystem behavior

The current filesystem stores:

- create parent directories with mode `0700` where supported;
- write temporary files with mode `0600`;
- rename the temporary file into place after a complete write;
- clean up temporary files after failed writes;
- treat a missing state file as an uninitialized runtime, not as corruption.

Platform-specific packaging may replace these stores with stronger secure storage while preserving the same interfaces.

## Enrollment persistence

A successful `InstallationEnrollmentClient.enroll()` can now receive an `InstallationBindingStore`.

The binding is persisted only after:

1. challenge validation;
2. signed proof creation;
3. Platform registration response;
4. bridge instance validation;
5. bridge key validation.

The one-time enrollment token is never persisted by this mechanism.

## Session lifetime

Session credentials remain ephemeral.

They must not be used as durable runtime state because:

- they expire quickly;
- they contain the operational access token;
- a restarted bridge can prove possession of its persistent identity and request a fresh session.

## Automatic renewal

`ControlSessionSupervisor` keeps the control session healthy.

Before each heartbeat it checks whether the active session is within the configured renew-before window.

If renewal is required, the supervisor:

1. loads and validates the persisted installation binding;
2. requests a fresh session challenge;
3. signs a new session proof with the persistent bridge identity;
4. receives a new short-lived session credential;
5. resumes heartbeat delivery.

No enrollment token is involved.

## Reconnect behavior

If opening a session or sending a heartbeat fails, the active session is invalidated and the supervisor retries using exponential backoff with bounded jitter.

Default values:

```text
initial delay: 1 second
maximum delay: 30 seconds
multiplier: 2
jitter: ±20%
```

A successful heartbeat resets the retry counter.

The backoff policy is configurable and deterministic under tests.

## Run loop

The supervisor exposes two levels:

- `tick(readiness)` for one deterministic open/renew + heartbeat cycle;
- `run(readinessProvider, AbortSignal)` for a long-running runtime process.

`run()` can be stopped cleanly with an `AbortSignal` and uses the heartbeat interval returned by Kairoseth Platform when present.

## Secret boundary

Persistent state:

- bridge private identity: secret;
- installation binding: sensitive configuration but not an operational access token.

Ephemeral state:

- session `accessToken`: secret, memory only;
- current session ID: operational metadata.

The session access token must never be written into runtime state files, logs, heartbeat payloads or audit event bodies.

## Deployment implications

### Docker / Linux

Mount a persistent state directory owned by the bridge service account. Losing that directory means losing the bridge identity and therefore requires an explicit recovery/re-enrollment procedure.

### Windows

The packaging layer should map the same stores onto a service-owned directory or replace the private-key store with Windows protected storage.

### WordPress / PrestaShop

Embedded adapters must place bridge state outside publicly reachable plugin/module assets. The private key must never be downloadable from an admin route.

### Hosted runtime

The filesystem implementation can be replaced by Kairoseth-managed secret storage while retaining the same `BridgeIdentityStore` and `InstallationBindingStore` contracts.

## Remaining resilience work

This phase does not yet provide:

- approval nonce replay protection;
- durable command delivery queue;
- command acknowledgement/retry protocol;
- trusted approval-key rotation after enrollment;
- sanitized audit event delivery over the control channel;
- OS keyring/TPM/HSM integration;
- cross-platform installer-specific ACL hardening.

Those remain explicit later steps rather than hidden assumptions.

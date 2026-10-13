# Kairoseth Agent Bridge — Sanitized Audit Delivery Protocol v1

## Purpose

Kairoseth Platform needs a trustworthy execution trail without turning the audit pipeline into a secondary secret store.

The bridge therefore sanitizes audit events **before persistence**, places only the sanitized records into a durable outbox, and retries delivery until Platform acknowledges individual event IDs.

## Audit event schema

The outbound event contract is:

```text
kab.audit-event.v1
```

A record contains only bounded execution metadata:

- `eventId`;
- tenant ID;
- installation ID;
- bridge instance ID;
- lifecycle event type;
- correlation ID;
- tool ID;
- actor ID;
- risk level;
- timestamp;
- optional policy outcome;
- optional sanitized message.

The audit event contract does not contain:

- tool input;
- tool output;
- approval token;
- session access token;
- connector credentials;
- bridge private key.

## Sanitization boundary

`SanitizedAuditSink` performs sanitization before calling the outbox store.

This is deliberate: secrets are not written to the local durable queue and then removed later.

Built-in message redaction covers common high-risk patterns including:

- Kairoseth signed approval tokens (`kab1...`);
- Bearer credentials;
- private-key PEM blocks;
- values labeled as token, access token, refresh token, password, secret, API key or authorization.

Control characters are removed and message length is bounded. Identifiers are normalized and length-limited.

Sanitization is defense in depth. Connector authors must still avoid placing secrets inside thrown error messages.

## Durable outbox

The repository provides:

- `InMemoryAuditOutboxStore` for tests/composition;
- `FileAuditOutboxStore` as the baseline persistent runtime implementation.

The file store uses:

- versioned state (`kab.audit-outbox.v1`);
- serialized in-process mutations;
- temporary-file writes;
- atomic rename;
- restrictive filesystem permissions where supported.

Events survive a runtime restart until acknowledged by Platform.

## Batch delivery

The runtime sends bounded batches:

```text
kab.audit-batch.v1
```

Each batch is bound to the current control session and includes:

- batch ID;
- session ID;
- tenant;
- installation;
- bridge instance;
- sanitized events.

The session access token is supplied to the transport separately and is never embedded in the batch payload.

Before sending, `AuditDeliveryClient` verifies that every queued event matches the active session scope.

## Acknowledgement

Platform replies with:

```text
kab.audit-batch-ack.v1
```

The acknowledgement contains:

- the exact batch ID;
- the event IDs that Platform durably accepted.

The bridge removes **only** acknowledged event IDs from the outbox.

Unknown IDs, duplicate IDs or a mismatched batch ID invalidate the acknowledgement and leave the outbox intact.

## Lost-response behavior

If Platform receives a batch but the connection drops before the bridge receives the ACK:

1. the events remain in the local outbox;
2. the bridge retries them later;
3. each event keeps the same stable `eventId`;
4. Platform can idempotently deduplicate by `eventId`.

Batch IDs may change between retries; event IDs do not.

This gives at-least-once transport with logical event deduplication.

## Partial acknowledgement

Platform may acknowledge only a subset of a batch.

Accepted events are removed. Unacknowledged events remain queued for a later attempt.

This supports partial ingestion failures without discarding the entire execution trail.

## Runtime behavior and failure semantics

The bridge core awaits its configured `AuditSink` during lifecycle transitions. With a durable sanitized sink this means audit persistence is part of the local execution control path rather than a fire-and-forget side channel.

A local outbox storage failure is therefore visible to the runtime instead of silently losing evidence.

Packaging should provision sufficient protected storage and monitoring for outbox growth.

## Data minimization

The bridge intentionally does not persist arbitrary inputs and outputs as audit events.

Products that need evidence payloads, fiscal artifacts, security reports or business-result archives should use product-specific evidence storage with explicit encryption, retention and access policies rather than overloading the generic Agent Bridge audit stream.

## End-to-end acceptance

Phase 1 includes an acceptance scenario that exercises:

```text
identity
  -> enrollment
  -> installation binding
  -> authenticated session
  -> signed approval key resolution
  -> single-use approval
  -> scoped command
  -> WRITE execution
  -> replay denial
  -> sanitized audit outbox
  -> authenticated audit batch
  -> event-level ACK
```

The acceptance test also asserts that session secrets and signed approval tokens are absent from queued audit data.

## Clustered deployments

The file outbox is intended for a single authoritative runtime process/state directory.

Multi-process or horizontally scaled runtimes should replace it with a shared durable queue/outbox that preserves stable event IDs and atomic acknowledgement semantics.

## Phase 1 completion

With sanitized audit delivery implemented, the native control-channel core provides the complete baseline chain required before Connector SDK work:

- persistent runtime identity;
- enrollment and installation binding;
- authenticated short-lived sessions;
- renewal/reconnect;
- signed approvals;
- approval replay protection;
- trusted approval-key rotation;
- reliable command delivery and crash-safe deduplication;
- sanitized reliable audit delivery.

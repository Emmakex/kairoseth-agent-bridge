# Kairoseth Agent Bridge — Command Delivery Protocol v1

## Purpose

The control channel needs a safe way for Kairoseth Platform to deliver tool invocations to a bridge runtime and receive acknowledgements without accidentally executing the same mutation twice after a network failure.

Version 1 defines:

- command envelopes;
- session scoping;
- action fingerprints;
- explicit acknowledgement states;
- durable local command receipts;
- retry/deduplication semantics.

## Command envelope

A command uses the logical shape:

```json
{
  "version": "kab.command.v1",
  "commandId": "cmd-...",
  "deliveryAttempt": 1,
  "tenantId": "tenant-...",
  "installationId": "installation-...",
  "bridgeInstanceId": "bridge-...",
  "correlationId": "corr-...",
  "actor": "agent-...",
  "toolId": "orders.update",
  "input": {},
  "actionFingerprint": "...",
  "approvalToken": "optional signed approval",
  "issuedAt": "...",
  "expiresAt": "..."
}
```

The `actionFingerprint` uses the same deterministic action fingerprint contract as signed approvals:

```text
tenant + installation + tool + correlationId + exact input
```

The bridge recomputes and verifies the fingerprint before execution.

## Session scope

A command is accepted only when these fields match the active short-lived control session:

- `tenantId`;
- `installationId`;
- `bridgeInstanceId`.

A command cannot be moved between installations or bridge instances simply by reusing the same payload.

## Delivery attempts

`commandId` identifies one logical command.

`deliveryAttempt` counts transport attempts for that same command. A retry may increase `deliveryAttempt`, but it must keep the same `commandId` and action fingerprint.

Reusing a `commandId` with a different action fingerprint is rejected.

## Command batch

The runtime fetches bounded batches using its current session access token.

```text
kab.command-batch.v1
```

A batch is bound to one `sessionId`. Batches for another session are rejected before command processing.

The default client batch size is 10 and the supported configurable range is 1–100.

## Two-phase local receipt

Before invoking a tool, the runtime durably stores:

```text
state = processing
commandId
fingerprint
startedAt
retainUntil
```

Only after execution has produced a result does the runtime replace that state with:

```text
state = completed
outcome
completedAt
```

This ordering matters.

### Why `processing` exists

Consider:

```text
1. Runtime receives WRITE command
2. Runtime executes external side effect
3. Runtime crashes before recording completion / sending ACK
4. Platform retries the same command
```

The runtime cannot safely know whether the remote business system applied the side effect.

Therefore a persisted `processing` receipt is treated as **indeterminate**. The bridge refuses automatic re-execution.

This is intentionally safer than pretending to offer exactly-once execution.

## ACK states

The command acknowledgement protocol is:

```text
kab.command-ack.v1
```

Possible status values:

- `executed` — tool executed successfully;
- `approval_required` — policy requires an approval not present/accepted yet;
- `denied` — policy denied the command;
- `failed` — execution failed;
- `expired` — command lifetime elapsed before execution;
- `rejected` — invalid version, scope, fingerprint, identifiers or other envelope invariant;
- `duplicate` — this command was already completed and was not executed again;
- `indeterminate` — a previous attempt started but no completion record exists.

For a duplicate acknowledgement, `originalOutcome` communicates the recorded prior outcome.

## Lost ACK behavior

If execution completes and the local completed receipt is persisted, but the network connection fails before Kairoseth Platform receives the ACK:

1. Platform retries the same `commandId`.
2. Runtime loads the durable receipt.
3. Runtime does **not** invoke the tool again.
4. Runtime responds `duplicate` with `originalOutcome`.

The durable receipt intentionally does not persist raw tool output or approval tokens.

This minimizes sensitive business data stored on the bridge while preserving the critical anti-double-execution guarantee.

## Result tradeoff

The immediate successful `executed` ACK may contain the tool output.

A later duplicate ACK after restart does not reconstruct that output from local disk. It reports only the prior outcome.

If a product requires durable result replay, that should be implemented as an explicitly encrypted result/evidence store rather than silently persisting arbitrary connector responses.

## Expiration

Commands have `issuedAt` and `expiresAt`.

The runtime rejects malformed lifetimes and commands issued beyond the allowed clock-skew window.

An otherwise valid command that has expired is recorded as completed with outcome `expired`, preventing later retries from unexpectedly executing it.

## Receipt retention

Receipts have a bounded `retainUntil` value and the store supports pruning.

The default processor retention window is 24 hours beyond the later of command expiry or completion time.

Production policy may increase this window where long retry horizons are required.

## File receipt store

`FileCommandReceiptStore` provides a baseline durable implementation using:

- versioned JSON state;
- temporary-file writes;
- atomic rename;
- `0600` file mode where supported;
- explicit pruning.

Higher-scale deployments can replace this with a database or embedded durable KV store behind the same interface.

## Security boundaries

Command-level deduplication does not replace approval replay protection.

A malicious or broken caller could theoretically create a different `commandId` around the same valid approval token. Therefore the signed approval `nonce` still needs its own replay/idempotency store.

That remains a separate Phase 1 security control.

## Next step

After this protocol, the remaining high-priority control-channel work is:

1. signed approval nonce replay enforcement;
2. trusted approval-key rotation;
3. sanitized audit event delivery;
4. command/audit integration with the Kairoseth Platform implementation.

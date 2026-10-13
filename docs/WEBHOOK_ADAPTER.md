# Kairoseth Agent Bridge — Webhook Adapter v1

## Purpose

The Webhook Adapter turns authenticated inbound HTTP webhook deliveries into normalized, durable Agent Bridge events.

It does **not** open a listening port by itself. HTTP exposure belongs to the deployment/package layer:

- Kairoseth hosted runtime;
- a customer-controlled reverse proxy/runtime;
- a WordPress/PrestaShop native adapter;
- another explicitly configured ingress surface.

This preserves the default Agent Bridge rule that local/on-prem runtimes do not require inbound ports unless the deployment intentionally enables webhook ingress.

## Flow

```text
External system
      |
      | POST + timestamp + nonce + auth/signature
      v
HTTP packaging layer
      |
      v
WebhookAdapter
      |
      +--> route/method/body limits
      +--> timestamp window
      +--> authentication / HMAC verification
      +--> JSON parsing + redaction
      +--> deterministic eventId
      +--> durable/idempotent event sink/outbox
      +--> replay nonce consumption
      v
NormalizedWebhookEvent
      |
      v
Kairoseth / event router / agent workflow
```

The adapter never directly executes a WRITE/CRITICAL Bridge tool merely because an external system sent a webhook. Any downstream mutating action still goes through normal Agent Bridge policy and signed approval controls.

## Fixed webhook definition

A webhook is declared ahead of time with:

- ID, name and description;
- fixed route/path;
- authentication method;
- timestamp/nonce replay policy;
- payload size limit;
- optional JSON-schema descriptor;
- optional payload redaction keys.

The caller cannot choose a tool, destination or arbitrary action through webhook metadata.

## HTTP envelope

v1 accepts `POST` only.

The route must exactly match the configured definition. Path definitions reject network-path syntax, query/fragment data, backslashes and dot traversal segments.

Webhook request bodies are raw bytes at verification time. This is required because HMAC signatures must be checked over exactly the received payload, before JSON parsing changes representation.

JSON is the supported payload format in v1.

## Authentication

### HMAC-SHA256

Default security profile.

Default headers:

```text
X-Kairoseth-Timestamp: <unix-seconds>
X-Kairoseth-Nonce: <unique-delivery-id>
X-Kairoseth-Signature: sha256=<hex-hmac>
```

The signed byte sequence is:

```text
<timestamp>.<nonce>.<raw-body-bytes>
```

The HMAC secret is resolved at runtime through `ConnectorSecretProvider`; it is never part of the webhook definition or normal configuration.

Signatures are compared using constant-time comparison.

Header names and the signature prefix can be adapted per integration while preserving the signing contract.

### Bearer

Bearer authentication is supported for systems that cannot produce an HMAC signature.

Bearer values also come from `ConnectorSecretProvider` and are constant-time compared after hashing.

Bearer mode still requires timestamp + nonce replay controls, but HMAC is preferred when the upstream system supports signing because it cryptographically binds the raw payload and replay metadata.

## Timestamp window

Every delivery includes a timestamp.

Default accepted skew:

```text
300 seconds
```

Configurable bounds are intentionally limited. A delivery outside the accepted clock window is rejected before event output.

## Nonce replay protection

Every delivery includes an opaque unique nonce/event identifier.

The replay store is scoped by:

```text
webhookId + nonce
```

A consumed nonce is retained at least as long as the timestamp acceptance window, so an attacker cannot wait for pruning and replay a still-valid delivery.

The replay record also stores the authenticated payload fingerprint and source timestamp. Reusing a nonce with a different payload is a conflict, not a new event.

`FileWebhookReplayStore` provides the same baseline atomic-file persistence approach used by other local Agent Bridge stores. Multi-process/clustered runtimes will require a shared transactional backend during production hardening.

## Crash-safe output order

The adapter generates a deterministic `eventId` from:

```text
webhook protocol version + webhookId + nonce
```

The normalized event is sent to an **idempotent durable sink before marking the nonce consumed**.

This ordering handles an important crash window:

1. webhook verifies;
2. event is persisted;
3. process crashes before replay record is written;
4. upstream retries the same delivery;
5. the sink sees the same eventId/fingerprint and does not duplicate it;
6. replay consumption completes.

`FileWebhookEventOutboxStore` implements this baseline locally and supports listing plus acknowledgement/removal for downstream delivery.

## Normalized event

```json
{
  "version": "kab.webhook-event.v1",
  "eventId": "...",
  "webhookId": "orders.changed",
  "receivedAt": "2026-10-13T15:10:00.000Z",
  "sourceTimestamp": "2026-10-13T15:09:58.000Z",
  "nonce": "evt-123",
  "payloadFingerprint": "...",
  "payload": {}
}
```

No authentication header or secret is included in the event.

## Payload redaction

Redaction happens before the payload enters the event sink/outbox.

The adapter recursively removes common sensitive fields such as:

- authorization;
- passwords;
- tokens;
- secrets;
- API keys;
- cookies;
- private keys/client secrets.

Webhook definitions can declare additional domain-specific key names to redact.

Resolved authentication secrets are also removed if an upstream system echoes them inside string values.

## Payload bounds

Default raw body limit:

```text
1 MiB
```

Hard v1 maximum:

```text
5 MiB
```

The HTTP packaging layer should also apply an equal or smaller streaming/request-body limit before allocating the entire request in memory. The adapter check is defense in depth, not a replacement for edge/network limits.

## Output adapter / outbox

`WebhookEventOutboxStore` is the output boundary for normalized webhook events.

Implementations in v1:

- in-memory store for tests/composition;
- atomic filesystem-backed store for a local single-writer runtime.

The outbox is idempotent by `eventId` and rejects an event-ID collision with a different payload fingerprint.

Downstream delivery can list events and acknowledge event IDs after Kairoseth/event-router acceptance.

## Failure behavior

The adapter fails closed for:

- wrong method/path;
- oversized body;
- malformed/multiple security headers;
- timestamp outside the allowed window;
- malformed nonce;
- invalid HMAC/Bearer authentication;
- invalid UTF-8/JSON;
- replay conflicts;
- unavailable replay persistence.

Authentication errors never echo the supplied or expected secret/signature.

## Deployment note

Webhook support does not change the default outbound-only architecture for private customer runtimes.

When a customer system can send webhooks only to a public endpoint, the recommended pattern is often:

```text
external SaaS -> Kairoseth hosted webhook ingress -> authenticated control/event channel -> customer runtime if needed
```

A local inbound webhook route is enabled only when the customer's topology explicitly supports and requires it.

# Kairoseth Agent Bridge — Outbound Control Session Protocol v1

## Purpose

After installation enrollment, a bridge runtime needs a short-lived authenticated session with Kairoseth Platform. The session carries operational traffic such as heartbeat, readiness, capability advertisement, commands and sanitized audit delivery.

The runtime initiates all normal connectivity. Local and on-premise deployments should not require an inbound firewall port.

## Preconditions

The runtime already has:

- a persistent Ed25519 bridge identity;
- an authoritative `InstallationBinding` issued by Kairoseth Platform;
- tenant and installation scope assigned by Platform;
- the bridge public key registered against that installation.

Enrollment credentials are not reused as normal session credentials.

## Session opening flow

```text
Kairoseth Platform                         Agent Bridge Runtime
       |                                          |
       |<----- outbound session challenge --------|
       |                                          |
       |--------- nonce + expiration ------------>|
       |                                          |
       |        sign nonce + installation scope   |
       |                                          |
       |<--------- signed session proof ----------|
       |                                          |
       | verify registered bridge key + scope     |
       | issue short-lived session credential     |
       |                                          |
       |--------- session credential ------------>|
       |                                          |
       |<--------- authenticated heartbeat -------|
       |--------- heartbeat ack ----------------->|
```

## Session proof

The runtime signs canonical JSON:

```json
{
  "version": "kab.session-proof.v1",
  "tenantId": "...",
  "installationId": "...",
  "bridgeInstanceId": "...",
  "keyId": "...",
  "nonce": "...",
  "issuedAt": "..."
}
```

The proof uses the same persistent Ed25519 identity created during enrollment.

Platform must verify the signature using the public key already bound to that installation. A valid self-signature for an unknown or differently bound key must not create a session.

## Session credential

Platform returns a short-lived credential:

```json
{
  "version": "kab.session-credential.v1",
  "sessionId": "...",
  "tenantId": "...",
  "installationId": "...",
  "bridgeInstanceId": "...",
  "keyId": "...",
  "accessToken": "opaque-secret",
  "issuedAt": "...",
  "expiresAt": "...",
  "heartbeatIntervalSeconds": 30
}
```

The runtime validates that the returned scope matches its authoritative installation binding exactly.

The access token is treated as secret material:

- it is passed separately from heartbeat/event payloads;
- it must not appear in normal audit payloads;
- it must not be printed by the runtime;
- it expires and must be renewed by opening a new session.

The implementation keeps the token format opaque. Kairoseth Platform may use an internal token representation without making token parsing part of the bridge contract.

## Heartbeat

A heartbeat contains non-secret operational state:

```json
{
  "version": "kab.heartbeat.v1",
  "sessionId": "...",
  "tenantId": "...",
  "installationId": "...",
  "bridgeInstanceId": "...",
  "sentAt": "...",
  "readiness": "ready",
  "runtimeVersion": "0.1.0",
  "capabilities": ["files", "woocommerce"]
}
```

Readiness values are:

- `starting`
- `ready`
- `degraded`

Capabilities are normalized, de-duplicated and sorted by the runtime.

The access token authenticating the heartbeat is not embedded in this payload.

## Runtime validation rules

The current core rejects:

- unsupported session challenge versions;
- missing or expired challenge nonces;
- credentials scoped to another tenant, installation, bridge instance or key;
- incomplete credentials;
- already-expired credentials;
- invalid credential lifetime;
- heartbeat intervals outside the accepted range;
- heartbeat attempts after credential expiration.

## Platform validation requirements

Kairoseth Platform must additionally enforce:

- nonce is unpredictable, single-use and short-lived;
- signed session proof uses the public key registered for the binding;
- session proof timestamp is inside the accepted clock-skew window;
- installation is active and permitted to connect;
- session token is high entropy and revocable;
- token is bound server-side to the same tenant/installation/bridge/key scope;
- expired/revoked sessions cannot send heartbeat, receive commands or submit events.

## Reconnect and renewal

Automatic reconnect/backoff and proactive renewal are deliberately the next microphase.

The runtime core already exposes credential expiration and heartbeat interval semantics so the reconnect controller can be added without changing the session protocol.

## Future traffic on the same control channel

After reconnect/renewal behavior is implemented, the authenticated control channel will carry:

- capability updates;
- readiness/health state;
- authorized invocation delivery;
- approval/public-key rotation metadata;
- sanitized audit events;
- command acknowledgements.

All traffic remains tenant/installation scoped.

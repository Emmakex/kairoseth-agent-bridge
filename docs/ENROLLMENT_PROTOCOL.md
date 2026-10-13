# Kairoseth Agent Bridge — Installation Enrollment Protocol v1

## Purpose

Before a runtime can establish an authenticated control session, Kairoseth Platform must know which bridge instance it is talking to and must bind that instance to the correct tenant and installation.

The runtime must not be allowed to choose its own `tenantId` or `installationId`.

## Local bridge identity

On first start, the runtime creates a persistent Ed25519 key pair and a random `bridgeInstanceId`.

The identity record is:

```text
kab.identity.v1
bridgeInstanceId
keyId = base64url(SHA-256(SPKI public key))
publicKeyPem
privateKeyPem
createdAt
```

The private key remains local to the runtime and is never included in registration proofs, audit events, capability advertisements or normal API responses.

Production runtime packaging must persist this identity in storage appropriate to the deployment environment and protect the private key with operating-system/filesystem controls. The current in-memory store exists for tests and composition only.

## Trust model

A self-signed bridge identity is not authorization.

It proves only that the runtime possesses the private key corresponding to the public key it presents.

Kairoseth Platform establishes authorization and ownership through a separate one-time enrollment token created for the intended tenant/installation.

Therefore the protocol separates:

1. **identity proof** — controlled by the runtime key pair;
2. **tenant/installation assignment** — controlled by Kairoseth Platform;
3. **future session credentials** — issued only after successful enrollment.

## Enrollment flow

```text
Kairoseth Platform                         Agent Bridge Runtime
       |                                          |
       |  administrator creates installation     |
       |  + one-time enrollment token            |
       |                                          |
       |<------- outbound request + token --------|
       |                                          |
       |--------- nonce + expiration ------------>|
       |                                          |
       |       runtime signs registration proof   |
       |                                          |
       |<--- token + signed registration proof ---|
       |                                          |
       | validate token, nonce, key possession    |
       | bind bridge to tenant + installation     |
       |                                          |
       |------ InstallationBinding -------------->|
       |                                          |
```

All network requests are initiated by the runtime. Local/on-premise customers do not need an inbound firewall port for enrollment.

## Enrollment challenge

The Platform returns:

```json
{
  "version": "kab.enrollment-challenge.v1",
  "nonce": "server-generated-single-use-value",
  "expiresAt": "2026-10-13T14:05:00.000Z"
}
```

The nonce must be unpredictable, short-lived and single-use on the Platform side.

The runtime rejects an already expired challenge before attempting registration.

## Registration proof

The runtime signs canonical JSON containing:

```json
{
  "version": "kab.registration.v1",
  "bridgeInstanceId": "...",
  "keyId": "...",
  "publicKeyPem": "...",
  "runtimeVersion": "...",
  "deploymentMode": "local",
  "capabilities": ["files", "woocommerce"],
  "nonce": "...",
  "issuedAt": "..."
}
```

The signature algorithm is Ed25519 and the signature is represented as unpadded base64url.

Capabilities are normalized, de-duplicated and sorted before signing.

Any change to the signed payload invalidates the signature.

## Platform-side verification requirements

Kairoseth Platform must verify at least:

1. enrollment token exists, is active, is intended for the correct installation and has not already been consumed;
2. challenge nonce exists, belongs to that enrollment flow, is unexpired and unused;
3. registration version is supported;
4. public key is valid Ed25519 material;
5. `keyId` matches the public-key fingerprint;
6. registration signature is valid;
7. `issuedAt` is inside the accepted clock-skew window;
8. runtime/deployment metadata is valid;
9. challenge is atomically consumed when enrollment succeeds.

The token and challenge are security credentials/state. They must not be written to normal application logs.

## Installation binding

After verification, **Platform**, not the runtime, returns the authoritative scope:

```json
{
  "version": "kab.installation-binding.v1",
  "tenantId": "tenant-platform-assigned",
  "installationId": "installation-platform-assigned",
  "bridgeInstanceId": "...",
  "keyId": "...",
  "registeredAt": "...",
  "trustedApprovalKeys": []
}
```

The runtime rejects a binding whose `bridgeInstanceId` or `keyId` does not match its local identity.

`trustedApprovalKeys` prepares the trust-bootstrap path for approval verification. Final key rotation and authenticated session delivery remain part of the next control-channel microphases.

## Deployment independence

This enrollment protocol is shared by every Agent Bridge packaging mode:

- hosted runtime;
- Docker/local runtime;
- Linux service;
- Windows service;
- WordPress/WooCommerce connector packaging;
- PrestaShop connector packaging;
- proprietary/custom software adapter.

Packaging can change. Identity and trust semantics must not.

## Next protocol layer

Successful enrollment does not itself create an unlimited permanent session.

The next control-channel layer will add short-lived authenticated session credentials bound to:

- tenant;
- installation;
- bridge instance;
- bridge key;
- expiration.

That session will carry heartbeat, readiness, capability advertisement, commands and sanitized audit delivery over outbound-only connectivity.

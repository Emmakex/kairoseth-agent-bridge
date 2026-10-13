# Installation Identity Security Notes

This document records implementation constraints for persistent bridge identity storage.

## Current code status

The core identity manager supports a storage abstraction and ships an in-memory implementation for tests and composition.

The in-memory store is **not** a production persistence strategy.

## Production storage requirements

A production runtime package must provide a platform-appropriate `BridgeIdentityStore` implementation.

Minimum requirements:

- persistent across runtime restarts;
- readable only by the bridge service account/user;
- private key never written to normal logs;
- atomic create/write behavior;
- reject malformed or mismatched key pairs;
- preserve the same `bridgeInstanceId` and key pair across routine upgrades;
- explicit rotation flow rather than silently generating a replacement identity;
- backup/restore behavior documented for the deployment package.

## Packaging direction

### Docker / Linux

Use a persistent mounted state directory with restrictive filesystem permissions. A later hardening phase may add OS keyring, TPM/HSM or encrypted-at-rest integration where required.

### Windows service

Use a service-owned persistent state location with ACLs restricted to the bridge service identity. Windows-protected key storage can be added by the Windows packaging layer.

### WordPress / PrestaShop packaging

Do not store the private bridge identity in publicly reachable web assets or plugin/module source files. The packaging adapter must choose a protected server-side state location and must never return the private key through an administrative HTTP response.

### Hosted runtime

Use the Kairoseth-managed secret/key infrastructure for the hosted runtime instance, while preserving the same logical identity contract.

## Rotation

Identity rotation must be explicit and coordinated with Kairoseth Platform. Losing or changing the local key must not silently inherit the old installation trust relationship.

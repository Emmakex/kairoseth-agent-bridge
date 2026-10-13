# Installation Identity Security Notes

This document records implementation constraints for persistent bridge identity storage.

## Current code status

The core identity manager supports a storage abstraction and now ships two implementations:

- `InMemoryBridgeIdentityStore` for tests/composition;
- `FileBridgeIdentityStore` for persistent runtime state.

The filesystem store writes through a temporary file and rename, creates parent directories with restrictive permissions where supported, and writes identity state with mode `0600`.

The in-memory store remains **not** a production persistence strategy.

## Production storage requirements

A production runtime package must use `FileBridgeIdentityStore` in an appropriately protected state directory or provide a stronger platform-specific `BridgeIdentityStore` implementation.

Minimum requirements:

- persistent across runtime restarts;
- readable only by the bridge service account/user;
- private key never written to normal logs;
- atomic create/write behavior;
- reject malformed or mismatched key pairs;
- preserve the same `bridgeInstanceId` and key pair across routine upgrades;
- explicit rotation flow rather than silently generating a replacement identity;
- backup/restore behavior documented for the deployment package.

## Installation binding

The Platform-authoritative `InstallationBinding` is persisted independently from the private identity.

`InstallationBindingManager` validates that the stored binding still matches the current `bridgeInstanceId` and `keyId` before using it. A binding copied from another runtime or left behind after identity replacement is rejected.

The enrollment token is not part of persisted runtime state.

## Packaging direction

### Docker / Linux

Use a persistent mounted state directory with restrictive filesystem permissions. The built-in file stores provide a baseline `0700` directory / `0600` file strategy where supported. A later hardening phase may add OS keyring, TPM/HSM or encrypted-at-rest integration where required.

### Windows service

Use a service-owned persistent state location with ACLs restricted to the bridge service identity. Windows-protected key storage can replace the filesystem private-key store in the Windows packaging layer.

### WordPress / PrestaShop packaging

Do not store the private bridge identity in publicly reachable web assets or plugin/module source files. The packaging adapter must choose a protected server-side state location and must never return the private key through an administrative HTTP response.

### Hosted runtime

Use the Kairoseth-managed secret/key infrastructure for the hosted runtime instance, while preserving the same logical `BridgeIdentityStore` contract.

## Session credentials

Short-lived control-session credentials are intentionally **not** persisted by the identity or binding stores.

After restart, the runtime reloads its long-lived identity and installation binding, proves possession of the private key again, and requests a fresh session credential.

## Rotation

Identity rotation must be explicit and coordinated with Kairoseth Platform. Losing or changing the local key must not silently inherit the old installation trust relationship.

Approval verification key rotation is a separate Platform-to-runtime control-channel concern and is not complete yet.

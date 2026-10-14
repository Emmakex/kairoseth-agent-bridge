# Kairoseth Platform control session and heartbeat

## ES

Tras completar el enrolamiento, Agent Bridge abre sesiones cortas contra Kairoseth Platform usando su binding persistido y la misma identidad Ed25519.

### Flujo

1. El runtime solicita un challenge de sesión enviando únicamente `tenantId`, `installationId`, `bridgeInstanceId` y `keyId` del binding.
2. Platform devuelve `kab.session-challenge.v1` con nonce de vida corta.
3. El runtime firma el challenge mediante `kab.session-proof.v1` y su clave privada Ed25519 local.
4. Platform valida instalación, nonce, timestamp y firma, y devuelve `kab.session-credential.v1` con token de acceso corto.
5. El runtime conserva el token solo en memoria y envía `kab.heartbeat.v1` usando `Authorization: Bearer ...`.
6. Platform confirma mediante `kab.heartbeat-ack.v1` y actualiza `lastSeenAt`, readiness, versión de runtime y capabilities.
7. `ControlSessionSupervisor` renueva la sesión antes de caducar y aplica backoff/jitter si se pierde la conectividad.

### Seguridad

- La clave privada Ed25519 nunca sale del runtime.
- El challenge y el proof no contienen credenciales de conectores.
- El token de sesión nunca se coloca en URL, query string ni body del heartbeat.
- Fuera de localhost se exige HTTPS por defecto.
- Los redirects HTTP están bloqueados.
- Los errores de transporte no reproducen bodies remotos ni tokens.
- El token de sesión es distinto e independiente del token de enrolamiento.
- La sesión autentica al runtime, pero no sustituye policy, approvals, replay protection ni audit de cada ejecución.

## EN

After enrollment, Agent Bridge opens short-lived sessions with Kairoseth Platform using its persisted installation binding and the same Ed25519 identity.

### Flow

1. The runtime requests a session challenge using only the binding `tenantId`, `installationId`, `bridgeInstanceId`, and `keyId`.
2. Platform returns a short-lived `kab.session-challenge.v1` nonce.
3. The runtime signs it as `kab.session-proof.v1` with its local Ed25519 private key.
4. Platform validates installation scope, nonce, timestamp, and signature, then returns a short-lived `kab.session-credential.v1` access token.
5. The runtime keeps the token in memory and sends `kab.heartbeat.v1` using `Authorization: Bearer ...`.
6. Platform responds with `kab.heartbeat-ack.v1` and updates `lastSeenAt`, readiness, runtime version, and capabilities.
7. `ControlSessionSupervisor` renews the session before expiration and uses backoff/jitter during connectivity loss.

### Security

- The Ed25519 private key never leaves the runtime.
- Challenges and proofs contain no connector credentials.
- The session token never appears in URLs, query strings, or the heartbeat body.
- HTTPS is required outside localhost by default.
- HTTP redirects are blocked.
- Transport errors do not reproduce remote bodies or tokens.
- Session access tokens are independent from enrollment tokens.
- Session authentication does not replace per-action policy, approvals, replay protection, or audit.

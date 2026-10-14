# Kairoseth Platform HTTP enrollment

## ES

Esta integración conecta el contrato de enrolamiento de Agent Bridge con la superficie real de Kairoseth Platform.

### Flujo

1. Un Product Owner o Admin de Agent Bridge genera en Kairoseth Platform un token de enrolamiento de un solo uso.
2. El runtime envía el token únicamente mediante `Authorization: Bearer ...` a `POST /api/products/agent-bridge/enrollment/challenge`.
3. Platform responde con un challenge `kab.enrollment-challenge.v1` de vida corta.
4. El runtime firma el nonce con su identidad persistente Ed25519 y envía `SignedRegistrationProof` a `POST /api/products/agent-bridge/enrollment/register`.
5. Platform valida token, expiración, nonce, fingerprint de la clave, timestamp y firma.
6. Platform asigna `tenantId` e `installationId`; el runtime no puede autoasignarlos.
7. El runtime valida el binding recibido y puede persistirlo con `InstallationBindingStore`.

### Seguridad

- El token nunca va en URL, query string ni logs de error del transporte.
- Fuera de localhost el transporte exige HTTPS por defecto.
- Los redirects HTTP están bloqueados durante enrolamiento.
- El runtime no acepta un binding dirigido a otro `bridgeInstanceId` o `keyId`.
- Platform almacena únicamente el hash del token y el hash del nonce del challenge.
- El token es de un solo uso; los reintentos del mismo registro pueden resolverse de forma idempotente por Platform.
- El enrolamiento establece identidad y scope. No sustituye policy, approvals, replay protection, connector health ni audit.

### Uso

`HttpEnrollmentTransport` implementa `OutboundEnrollmentTransport` y se conecta directamente con `InstallationEnrollmentClient`.

```ts
const transport = new HttpEnrollmentTransport({
  baseUrl: "https://kairoseth.com",
});

const enrollment = new InstallationEnrollmentClient(identityManager, transport, {
  runtimeVersion: "0.1.0",
  deploymentMode: "local",
  capabilities: ["woocommerce", "files"],
  bindingStore,
});

await enrollment.enroll(enrollmentToken);
```

## EN

This integration connects the Agent Bridge enrollment contract to the real Kairoseth Platform control plane.

### Flow

1. An Agent Bridge Product Owner or Admin generates a one-time enrollment token in Kairoseth Platform.
2. The runtime sends the token only through `Authorization: Bearer ...` to `POST /api/products/agent-bridge/enrollment/challenge`.
3. Platform returns a short-lived `kab.enrollment-challenge.v1` challenge.
4. The runtime signs the nonce with its persistent Ed25519 identity and submits the `SignedRegistrationProof` to `POST /api/products/agent-bridge/enrollment/register`.
5. Platform validates the token, expiration, nonce, key fingerprint, timestamp, and signature.
6. Platform assigns `tenantId` and `installationId`; the runtime cannot self-assert either value.
7. The runtime validates the returned binding and may persist it through `InstallationBindingStore`.

### Security

- The token never appears in URLs, query strings, or transport error messages.
- HTTPS is required outside localhost by default.
- HTTP redirects are blocked during enrollment.
- The runtime rejects a binding targeting another `bridgeInstanceId` or `keyId`.
- Platform stores only the token hash and challenge nonce hash.
- The token is single-use; retries of the same registration can be handled idempotently by Platform.
- Enrollment establishes identity and scope. It does not replace policy, approvals, replay protection, connector health, or audit.

### Usage

`HttpEnrollmentTransport` implements `OutboundEnrollmentTransport` and plugs directly into `InstallationEnrollmentClient`.

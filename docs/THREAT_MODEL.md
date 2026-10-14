# Agent Bridge — Threat Model / Modelo de amenazas

Version: 1.0 baseline — 2026-10-14

## ES

### 1. Objetivo y alcance

Este modelo cubre el core compartido de Agent Bridge, su canal de control con Kairoseth Platform, protocolos MCP/A2A, Connector SDK, conectores oficiales, almacenamiento operativo local, artefactos de release y las fronteras de despliegue hosted/hybrid/on-premises.

El objetivo principal es impedir que una identidad no autorizada, un agente, un conector o un backend externo conviertan el bridge en una ruta para saltarse tenant isolation, policy, approvals, audit o los límites explícitos de cada herramienta.

No se asume que el modelo pueda mantener confidencialidad frente a un atacante con control root/Administrator completo y persistente sobre el host del runtime. Ese escenario se trata como compromiso del host y requiere aislamiento del sistema operativo, gestión de secretos, reinstalación/rotación y respuesta operativa.

### 2. Activos críticos

- identidad Ed25519 persistente del bridge y su clave privada;
- binding autoritativo tenant + installation + bridge instance;
- session credentials de corta duración y enrollment material;
- claves públicas de confianza para approvals/delegation y su cadena de rotación;
- secretos de conectores obtenidos mediante `SecretProvider`;
- autoridad de ejecución READ / WRITE / CRITICAL;
- fingerprints, correlation IDs, nonces y recibos de idempotencia/replay;
- datos de negocio leídos o mutados a través de conectores;
- audit trail sanitizado y su relación con la ejecución real;
- colas/receipts/task state persistidos;
- artifacts, checksums, SBOM y attestations de release.

### 3. Fronteras de confianza

**TB-1 — Kairoseth Platform -> runtime.** Platform asigna identidad de tenant/installation, emite sesiones, approvals y material de confianza. El runtime no puede autoasignarse una identidad distinta.

**TB-2 — runtime -> sistema cliente.** Los conectores cruzan desde el proceso Agent Bridge hacia WooCommerce, PrestaShop, MySQL, filesystem, REST APIs u otros backends. Cada conector debe reducir la superficie a operaciones declaradas.

**TB-3 — caller/protocol -> BridgeRuntime.** MCP, A2A, control channel y adapters externos son entradas no autoritativas hasta que identidad, scope, policy y approval han sido verificados.

**TB-4 — host local -> persistencia.** Identidad, receipts, replay state y colas operativas sobreviven reinicios. El contenido sensible temporal se cifra y la integridad debe fallar cerrada ante manipulación.

**TB-5 — source -> CI -> release artifact.** Dependencias, build, SBOM, hashes y provenance deben conservar una relación verificable desde el commit fuente hasta el artifact distribuido.

### 4. Adversarios considerados

- caller externo no autenticado;
- agente autenticado pero malicioso o comprometido;
- principal válido intentando cruzar tenant/installation scope;
- webhook sender falsificado o replay de tráfico válido;
- backend/conector remoto comprometido o con comportamiento hostil;
- operador con permisos limitados intentando escalar capacidades;
- atacante con acceso de lectura/escritura parcial al almacenamiento local;
- atacante de supply chain intentando sustituir dependencia o artifact;
- fallo de infraestructura que produzca duplicados, carreras, timeouts o estado parcial.

### 5. Amenazas, controles y riesgo residual

| ID | Amenaza | Controles actuales | Residual / siguiente control |
| --- | --- | --- | --- |
| TM-01 | Suplantación de bridge o tenant | identidad Ed25519 persistente, proof of possession, binding asignado por Platform, scope exacto en sesión | compromiso total del host requiere revocación/re-enrollment |
| TM-02 | Cross-tenant/cross-installation execution | tenant + installation + actor en `InvocationContext`, scoping exacto de commands/tasks/approvals, fail-closed mismatch | pruebas multi-tenant de despliegue real pendientes junto a Platform UI |
| TM-03 | Approval tampering o replay | firma, action fingerprint exacto, correlation/command binding, expiry, nonce single-use persistente | datastore compartido debe conservar atomicidad en cluster |
| TM-04 | Ejecución WRITE/CRITICAL sin aprobación | secure-default policy y BridgeRuntime como única ruta de ejecución; MCP/A2A no ejecutan tool handlers directamente | una nueva adapter futura debe demostrar la misma propiedad en acceptance |
| TM-05 | Tool/payload injection | tools declaradas, schemas estrictos, rechazo de campos desconocidos, payload bounds, no arbitrary SQL/HTTP/resource APIs | connectors custom siguen dependiendo de revisión de sus manifests |
| TM-06 | SSRF / pivot de red | HTTPS por defecto, bloqueo private/local en Generic REST, allowlists explícitas, redirects bloqueados; excepciones on-prem opt-in | deployment local que habilita red privada aumenta deliberadamente el trust surface |
| TM-07 | Robo/exposición de secretos | `SecretProvider`, secretos fuera de manifests/input, redacción de responses/errors/audit, tokens Bearer solo en headers | un host root-compromised puede observar secretos en memoria durante ejecución |
| TM-08 | Path traversal / symlink escape | roots absolutos confiables, paths relativos estrictos, `lstat`, canonicalización, `O_NOFOLLOW`, dotfiles/extension bounds | semántica filesystem depende también de garantías del OS/filesystem subyacente |
| TM-09 | SQL injection o SQL administrativo | perfiles SQL predeclarados, prepared statements, placeholder count, no arbitrary SQL/DDL/comments/multi-statements, READ transactions | perfiles custom peligrosos deben permanecer fuera del catálogo por defecto |
| TM-10 | Webhook spoof/replay | HMAC/Bearer auth, timestamp window, nonce persistence, payload digest/idempotency | disponibilidad del replay store sigue siendo dependencia crítica |
| TM-11 | Delegation abuse entre agentes | verified transport identity, signed delegation, exact tool allowlist/risk ceiling, revocation fail-closed, WRITE sigue requiriendo approval | revocation/identity resolver deben ser altamente disponibles para no bloquear trabajo legítimo |
| TM-12 | Protocol downgrade o metadata spoofing | MCP moderno; legacy opt-in explícito; A2A v1; metadata no puede sobreescribir identidad/approval confiable | nuevas compatibilidades deben ser opt-in y aisladas |
| TM-13 | DoS por volumen/payload/backend | payload bounds, rate limits, tool timeouts, bounded retries, circuit breakers, health isolation | no sustituye rate limiting de red/WAF del deployment host |
| TM-14 | Backend comprometido devuelve datos hostiles | response bounds/redaction, schemas normalizados, circuit breaker y health isolation | Agent Bridge no puede garantizar veracidad semántica de un backend autorizado comprometido |
| TM-15 | Duplicación por crash/redelivery | atomic claim -> execute -> complete, compare-and-set, stable fingerprints, approval nonce single-winner | clustered stores deben implementar las primitivas atómicas documentadas |
| TM-16 | Manipulación de cola local | AES-256-GCM, scope binding, TTL/size bounds, atomic persistence, key rewrap | copia simultánea de ciphertext + key por host compromise rompe confidencialidad |
| TM-17 | Credential rotation parcial | ejecución bloqueada durante refresh, timeout duro, fallo fail-closed, health projection, rotation IDs idempotentes | provider externo debe soportar rotación/revocación de forma coherente |
| TM-18 | Fuga en logs/audit/errors | sanitización antes de persistir, mensajes acotados, raw backend errors suprimidos, metadata-only snapshots | nuevas fuentes de log deben pasar por el mismo contrato de sanitización |
| TM-19 | Sustitución de artifact/dependency | `package-lock.json`, `npm ci`, integrity hashes npm, SBOM, production audit, CodeQL, SHA256SUMS, SLSA + CycloneDX attestations | promoción/tag estable y política formal de release aún pendientes |
| TM-20 | Update/rollback malicioso o accidental | artifact actual tiene digest/provenance verificable | instalación, version pinning, anti-downgrade y rollback seguro siguen pendientes de Phase 6 |

### 6. Invariantes de seguridad obligatorias

1. Ningún adapter de protocolo llama directamente al handler de una tool saltándose `BridgeRuntime`.
2. Un caller no puede proporcionar su propio tenant, installation, actor o approval y convertirlo en autoridad sin verificación externa.
3. Toda mutación WRITE/CRITICAL permanece detrás de policy y approval incluso cuando existe delegation válida.
4. Replay/idempotency se decide con estado persistente/atómico cuando una operación puede duplicar side effects.
5. Los conectores oficiales exponen operaciones allowlisted y no clientes genéricos arbitrarios.
6. Los secretos nunca forman parte de inventory, discovery, manifest público, audit sanitizado ni errores devueltos.
7. Una degradación de observabilidad no debe desactivar policy; una degradación de un connector no debe tumbar connectors sanos.
8. Cualquier excepción que debilite defaults de red/TLS/legacy protocol debe ser deployment opt-in explícito.
9. Un rename comercial no cambia IDs, scopes, rutas o contratos de seguridad.
10. Un release promovido debe conservar el mismo digest ya construido y atestado.

### 7. Evidencia automatizada existente

La suite cubre, entre otros, approval exact-action + replay, command crash dedupe, shared idempotency, admission/rate limits, circuit breakers, connector health isolation, credential rotation, filesystem traversal/symlinks, SQL safety, webhook auth/replay, MCP policy enforcement, A2A identity/delegation/provenance, encrypted queue y control-plane lifecycle.

CI añade instalación reproducible, typecheck/tests/build, SBOM CycloneDX, `npm audit` para dependencias de producción y CodeQL `security-extended`. El workflow Release Integrity añade checksums y attestations de provenance/SBOM sobre el artifact de runtime.

### 8. Riesgos todavía abiertos en Phase 6

- durable/clustered A2A task storage de producción;
- failure/rollback drills reproducibles;
- estrategia de instalación/update/anti-downgrade/rollback;
- Docker packaging;
- Linux service packaging;
- Windows service packaging;
- observability dashboards y operator surfaces ES/EN en Kairoseth Platform;
- política formal de tagging/promoción de release estable.

Estos riesgos no deben cerrarse solo con documentación: cada uno necesita una evidencia ejecutable o un acceptance drill antes de marcarse completo.

---

## EN

### 1. Goal and scope

This model covers the shared Agent Bridge core, its control channel to Kairoseth Platform, MCP/A2A protocols, Connector SDK, official connectors, local operational storage, release artifacts, and hosted/hybrid/on-premises deployment boundaries.

The primary goal is to prevent an unauthorized identity, agent, connector, or external backend from turning the bridge into a path around tenant isolation, policy, approvals, audit, or explicit tool boundaries.

The model does not assume confidentiality can survive a persistent attacker with full root/Administrator control of the runtime host. That scenario is treated as host compromise and requires OS isolation, secret rotation, reinstallation/re-enrollment, and operational response.

### 2. Critical assets

Critical assets include the persistent Ed25519 bridge identity/private key, authoritative tenant/installation binding, short-lived sessions and enrollment material, approval/delegation trust keys, connector secrets, execution authority, replay/idempotency state, business data, sanitized audit lineage, durable operational state, and release artifacts/SBOM/attestations.

### 3. Trust boundaries

**TB-1 — Kairoseth Platform -> runtime.** Platform assigns tenant/installation identity and distributes sessions, approvals, and trust material. The runtime cannot self-assert a different authoritative identity.

**TB-2 — runtime -> customer system.** Connectors cross into WooCommerce, PrestaShop, MySQL, filesystems, REST APIs, or other systems. Each connector must reduce access to declared operations.

**TB-3 — caller/protocol -> BridgeRuntime.** MCP, A2A, control channel, and external adapters remain untrusted inputs until identity, scope, policy, and approvals are verified.

**TB-4 — local host -> persistence.** Identity, receipts, replay state, and queues survive restart. Sensitive temporary state is encrypted and integrity failures are fail-closed.

**TB-5 — source -> CI -> release artifact.** Dependency resolution, build output, SBOM, hashes, and provenance must remain verifiably linked to the source commit.

### 4. Considered adversaries

The model considers unauthenticated callers, malicious/compromised authenticated agents, principals attempting tenant-scope crossing, spoofed/replayed webhooks, compromised remote backends, limited operators attempting privilege expansion, attackers with partial local-storage access, supply-chain artifact substitution, and infrastructure failures causing races/duplicates/partial state.

### 5. Threat conclusions

The detailed TM-01 through TM-20 table in the ES section is normative for both locales. In summary, the architecture relies on cryptographic identity/binding, exact scoped authorization, secure-default approval for mutations, declared connector surfaces, network/filesystem/database guardrails, persistent replay/idempotency, bounded resource usage, secret-safe observability, and verifiable build provenance.

Full host compromise, intentionally relaxed on-prem network defaults, semantic compromise of an already-authorized backend, and future update/rollback mechanisms remain explicit residual risks rather than hidden assumptions.

### 6. Mandatory security invariants

1. Protocol adapters never bypass `BridgeRuntime` to call tool handlers directly.
2. Caller-provided tenant/installation/actor/approval metadata never becomes authoritative without external verification.
3. WRITE/CRITICAL mutations remain behind policy and approval even with valid delegation.
4. Side-effecting replay/idempotency decisions use persistent/atomic state where duplicates are possible.
5. Official connectors expose allowlisted operations rather than arbitrary generic clients.
6. Secrets never appear in inventory, discovery, public manifests, sanitized audit, or returned raw errors.
7. Observability degradation never disables policy; one connector failure remains isolated from healthy connectors.
8. Any network/TLS/legacy-protocol weakening is an explicit deployment opt-in.
9. Commercial renaming never mutates security IDs/scopes/contracts.
10. Release promotion reuses the already attested digest rather than rebuilding different bytes.

### 7. Automated evidence

Existing tests cover exact-action approvals/replay, crash-safe command dedupe, shared idempotency, admission/rate limits, circuit breakers, connector health isolation, credential rotation, filesystem traversal/symlink defense, SQL safety, webhook authentication/replay, MCP policy enforcement, A2A identity/delegation/provenance, encrypted local queues, and control-plane lifecycle.

CI adds reproducible installs, typecheck/tests/build, CycloneDX SBOM, production dependency auditing, and CodeQL `security-extended`. Release Integrity adds checksums plus provenance and SBOM attestations over the runtime artifact.

### 8. Open Phase 6 risks

Production-durable clustered A2A task storage, failure/rollback drills, installation/update/anti-downgrade strategy, Docker/Linux/Windows packaging, Platform observability/operator surfaces, and formal stable-release promotion remain open. They require executable evidence or acceptance drills before completion.

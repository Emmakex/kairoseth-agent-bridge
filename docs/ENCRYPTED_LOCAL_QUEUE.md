# Encrypted Temporary Local Queue / Cola local temporal cifrada

## ES

### Objetivo

La cola local cifrada de Kairoseth Agent Bridge sirve únicamente para **estado operacional temporal** que debe sobrevivir a un reinicio o a una pérdida breve de conectividad.

Casos válidos incluyen reintentos de entrega, eventos pendientes de ACK, reconciliación local y otros mensajes operativos de vida corta.

No es una base de datos de negocio y no debe almacenar catálogos, clientes, pedidos completos, expedientes, históricos permanentes ni una copia local del control plane de Kairoseth.

### Cifrado

El formato `kab.encrypted-local-queue.v1` usa:

- AES-256-GCM;
- nonce aleatorio de 96 bits en cada escritura;
- tag de autenticación GCM de 128 bits;
- AAD ligada a versión, algoritmo, `scope` del runtime y `keyId`;
- un `keyId` visible para resolver la clave, pero nunca la clave junto al ciphertext.

El fichero no contiene el payload en claro. Si el ciphertext, el tag, el scope o la clave no coinciden, la lectura falla cerrada.

### Gestión de claves

`LocalQueueKeyProvider` separa cifrado y gestión de claves. El runtime pregunta:

- cuál es la clave activa para nuevas escrituras;
- qué clave corresponde a un `keyId` antiguo durante lectura.

Producción debe implementar este contrato mediante un secreto de despliegue, OS key store, KMS/HSM o mecanismo equivalente. `InMemoryLocalQueueKeyProvider` es una implementación de referencia para tests/local/dev, no un almacén persistente de secretos.

La operación `rewrap()` descifra el estado actual y lo vuelve a cifrar con la clave activa. Tras comprobar el rewrap puede retirarse una clave antigua conforme a la política de rotación.

### Límites y retención

Cada entrada exige TTL. La cola aplica límites explícitos para:

- número total de elementos;
- tamaño máximo del payload JSON;
- tamaño máximo del estado cifrado/descifrado;
- TTL máximo;
- número máximo de IDs por ACK.

Las entradas expiradas se eliminan durante las operaciones normales y mediante `pruneExpired()`.

### Persistencia

La implementación de fichero:

- serializa operaciones concurrentes dentro del proceso;
- escribe a un fichero temporal y usa `rename` atómico;
- intenta mantener el directorio en `0700` y el fichero en `0600` en plataformas POSIX;
- nunca hace fallback a almacenamiento en claro.

La escritura atómica protege frente a un proceso que cae mientras reemplaza el estado, pero no convierte el fichero en almacenamiento distribuido. El hardening clustered/shared se trata por separado.

### Scope

El `scope` forma parte de la AAD. Debe ser estable y específico de la instalación/runtime, por ejemplo una composición interna derivada de tenant + installation + bridge instance.

Copiar un fichero cifrado a otro scope no debe hacerlo legible aunque use el mismo material de clave.

### Datos permitidos

La regla práctica es: almacenar solo el mínimo estado necesario para poder **reanudar/reintentar/reconciliar** una operación.

No almacenar:

- claves privadas;
- approval/delegation/session tokens salvo que un protocolo concreto lo requiera expresamente y tenga retención mínima definida;
- credenciales de conectores;
- bases de datos de negocio completas;
- payloads sin TTL;
- información que Kairoseth Platform ya mantiene como fuente autoritativa.

## EN

### Purpose

The Kairoseth Agent Bridge encrypted local queue is only for **temporary operational state** that must survive a restart or a short connectivity outage.

Valid uses include delivery retries, events awaiting ACK, local reconciliation and other short-lived operational messages.

It is not a business database and must not store catalogs, customer databases, complete order history, permanent records or a local replica of the Kairoseth control plane.

### Encryption

The `kab.encrypted-local-queue.v1` format uses:

- AES-256-GCM;
- a random 96-bit nonce for every write;
- a 128-bit GCM authentication tag;
- AAD bound to format version, algorithm, runtime `scope` and `keyId`;
- a visible `keyId` used to resolve the key, while key material is never serialized next to ciphertext.

The file does not contain payload plaintext. Ciphertext, tag, scope or key mismatch causes a fail-closed read.

### Key management

`LocalQueueKeyProvider` separates encryption from key custody. The runtime asks for:

- the active key used for new writes;
- the historical key that matches a stored `keyId` during reads.

Production deployments should implement this contract with a deployment secret, OS key store, KMS/HSM or equivalent mechanism. `InMemoryLocalQueueKeyProvider` is a reference implementation for tests/local/dev and is not a persistent secret store.

`rewrap()` decrypts current state and encrypts it again with the provider's active key. Once rewrap is verified, an old key can be retired according to the deployment rotation policy.

### Bounds and retention

Every entry requires a TTL. Explicit limits apply to:

- total item count;
- JSON payload bytes;
- encrypted/decrypted state bytes;
- maximum TTL;
- acknowledgement batch size.

Expired entries are removed during normal operations and through `pruneExpired()`.

### Persistence

The file implementation:

- serializes concurrent operations inside one process;
- writes a temporary file and uses atomic `rename`;
- attempts `0700` directory and `0600` file permissions on POSIX platforms;
- never falls back to plaintext persistence.

Atomic replacement protects against a process dying while replacing the state file, but does not make the file a distributed store. Cluster/shared-deployment hardening is handled separately.

### Scope

The `scope` participates in AAD. It should be stable and installation/runtime-specific, for example an internal value derived from tenant + installation + bridge instance.

Moving an encrypted file to another scope must not make it readable even when the same key material is available.

### Allowed data

The practical rule is to store only the minimum state required to **resume/retry/reconcile** an operation.

Do not store:

- private keys;
- approval/delegation/session tokens unless a specific protocol explicitly requires them and defines minimal retention;
- connector credentials;
- complete business datasets;
- payloads without TTL;
- data already authoritatively held by Kairoseth Platform.

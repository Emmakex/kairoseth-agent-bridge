# MySQL Connector / Conector MySQL

## ES

El conector oficial MySQL de Kairoseth Agent Bridge **no expone SQL libre**. Cada tool nace de un perfil declarado por código/configuración de despliegue confiable y el agente únicamente puede proporcionar los valores de parámetros previamente definidos.

### Modelo de perfiles

Un perfil declara:

- ID técnico estable;
- nombre y descripción canónicos;
- nombre y descripción ES/EN;
- riesgo `READ`, `WRITE` o `CRITICAL`;
- statement SQL fijo;
- parámetros posicionales correspondientes a `?`;
- tipos, obligatoriedad y límites de cada parámetro;
- límite máximo de filas para READ;
- columnas adicionales a redactar;
- idempotencia de mutaciones cuando proceda;
- timeout opcional.

Ejemplo conceptual:

```ts
{
  id: "orders.by-customer",
  risk: "READ",
  statement:
    "SELECT id, total, status FROM orders WHERE customer_id = ? LIMIT ?",
  parameters: [
    { id: "customerId", type: "integer", minimum: 1 },
    { id: "limit", type: "integer", minimum: 1, maximum: 100 }
  ],
  maxRows: 100,
  localizations: {
    es: {
      name: "Pedidos por cliente",
      description: "Lista pedidos de un cliente mediante un perfil MySQL acotado."
    },
    en: {
      name: "Orders by customer",
      description: "Lists customer orders through a bounded MySQL profile."
    }
  }
}
```

El statement no forma parte del inputSchema ni del manifest visible al agente.

### Prepared statements

El runtime usa `mysql2/promise` y `execute()` para todos los statements del profile. Los valores llegan a MySQL como parámetros preparados; nunca se concatenan con el SQL.

Los parámetros admitidos inicialmente son:

- `string`;
- `integer`;
- `number`;
- `boolean`;
- `date`;
- `date-time`.

Un parámetro opcional ausente se enlaza como `NULL`. Cualquier campo de input no declarado se rechaza antes de abrir una conexión.

### Política SQL al registrar perfiles

La validación ocurre cuando se construye el conector, antes de exponer tools:

- READ debe comenzar por `SELECT`;
- READ debe incluir `LIMIT`;
- mutaciones solo pueden comenzar por `INSERT`, `UPDATE` o `DELETE`;
- `DELETE` exige riesgo `CRITICAL`;
- se rechazan multi-statements;
- se rechazan comentarios SQL;
- se bloquean DDL y capacidades como `CREATE`, `ALTER`, `DROP`, `TRUNCATE`, `GRANT`, `REVOKE`, `LOAD`, `OUTFILE` y `DUMPFILE`;
- el número de `?` debe coincidir exactamente con los parámetros del profile;
- máximo 64 parámetros por profile;
- todos los perfiles requieren metadata ES y EN.

Este validador es deliberadamente conservador. Si una integración necesita SQL más complejo, debe ampliarse el contrato explícitamente en vez de abrir una vía de SQL arbitrario.

### READ

Los perfiles READ:

- se ejecutan dentro de `START TRANSACTION READ ONLY`;
- pueden reintentarse únicamente ante errores transitorios reconocidos;
- tienen `maxRows` con default 500 y máximo 5000;
- redactan recursivamente columnas sensibles como password, secret, token, api_key y las columnas adicionales declaradas por el profile;
- devuelven `{ rows, rowCount }`.

El `LIMIT` del statement sigue siendo obligatorio aunque exista `maxRows`: el SQL debe estar acotado también en el servidor, no solo en la respuesta normalizada.

### WRITE y CRITICAL

Las mutaciones:

- se ejecutan en transacción explícita;
- pasan siempre por la policy `WRITE`/`CRITICAL` del Bridge;
- con la policy segura por defecto devuelven `approval_required` antes de tocar MySQL;
- declaran `retry: never`;
- no devuelven filas arbitrarias, solo un resumen normalizado de `affectedRows`, `changedRows`, `insertId` y `warningStatus` cuando estén disponibles;
- pueden declarar idempotencia `none`, `intrinsic` o `keyed` según el profile.

Una desconexión durante una mutación no provoca una segunda ejecución automática.

### Configuración y credenciales

La configuración no secreta contiene:

```json
{
  "host": "db.example.com",
  "port": 3306,
  "database": "appdb",
  "tlsMode": "verify",
  "connectTimeoutMs": 5000
}
```

Credenciales gestionadas mediante `ConnectorSecretProvider`:

- `username`;
- `password`;
- `tls_ca` opcional para un bundle CA PEM.

TLS verificado es el default. `tlsMode: "disabled"` solo funciona si el despliegue del conector lo habilita explícitamente mediante `allowTlsDisabled`.

El constructor puede declarar además `allowedHosts`, una allowlist exacta de destinos permitidos.

### Privilegios mínimos

El profile limita lo que puede solicitar el agente, pero la cuenta de base de datos debe seguir el principio de mínimo privilegio:

- una instancia puramente READ debería usar una cuenta MySQL solo-lectura;
- perfiles de escritura deberían limitarse a las tablas/operaciones necesarias;
- operaciones destructivas deberían usar perfiles `CRITICAL` y permisos específicos;
- no debe reutilizarse una cuenta administrativa/root para Agent Bridge.

### ES/EN

El conector, setup y todos los profiles requieren metadata ES/EN. Los IDs técnicos, SQL, nombres de tablas/columnas y decisiones de seguridad permanecen independientes del idioma.

---

## EN

The official Kairoseth Agent Bridge MySQL connector **does not expose free-form SQL**. Every tool comes from a profile declared by trusted deployment code/configuration, and the agent can only provide values for predeclared parameters.

### Profile model

A profile declares:

- stable technical ID;
- canonical name and description;
- ES and EN name/description;
- `READ`, `WRITE` or `CRITICAL` risk;
- fixed SQL statement;
- positional parameters matching `?` placeholders;
- parameter types, requirements and bounds;
- maximum READ row count;
- additional result columns to redact;
- mutation idempotency when applicable;
- optional timeout.

Conceptual example:

```ts
{
  id: "orders.by-customer",
  risk: "READ",
  statement:
    "SELECT id, total, status FROM orders WHERE customer_id = ? LIMIT ?",
  parameters: [
    { id: "customerId", type: "integer", minimum: 1 },
    { id: "limit", type: "integer", minimum: 1, maximum: 100 }
  ],
  maxRows: 100,
  localizations: {
    es: {
      name: "Pedidos por cliente",
      description: "Lista pedidos de un cliente mediante un perfil MySQL acotado."
    },
    en: {
      name: "Orders by customer",
      description: "Lists customer orders through a bounded MySQL profile."
    }
  }
}
```

The statement is not part of the input schema or agent-visible manifest.

### Prepared statements

The runtime uses `mysql2/promise` and `execute()` for every profile statement. Values are sent to MySQL as prepared parameters and are never concatenated into SQL.

Initially supported parameter types are:

- `string`;
- `integer`;
- `number`;
- `boolean`;
- `date`;
- `date-time`.

A missing optional parameter is bound as `NULL`. Any undeclared input field is rejected before a database connection is opened.

### SQL policy at profile registration

Validation happens when the connector is constructed, before tools are exposed:

- READ must start with `SELECT`;
- READ must include `LIMIT`;
- mutations may only start with `INSERT`, `UPDATE` or `DELETE`;
- `DELETE` requires `CRITICAL` risk;
- multiple statements are rejected;
- SQL comments are rejected;
- DDL/capabilities such as `CREATE`, `ALTER`, `DROP`, `TRUNCATE`, `GRANT`, `REVOKE`, `LOAD`, `OUTFILE` and `DUMPFILE` are blocked;
- the number of `?` placeholders must exactly match profile parameters;
- at most 64 parameters per profile;
- every profile requires both ES and EN metadata.

The validator is intentionally conservative. More complex SQL should extend the explicit contract rather than opening an arbitrary-SQL path.

### READ

READ profiles:

- execute inside `START TRANSACTION READ ONLY`;
- retry only recognized transient failures;
- use `maxRows`, default 500 and hard-capped at 5000;
- recursively redact sensitive columns such as password, secret, token and api_key plus profile-declared columns;
- return `{ rows, rowCount }`.

A SQL `LIMIT` remains mandatory even with `maxRows`: queries must be bounded server-side as well as in normalized output.

### WRITE and CRITICAL

Mutations:

- execute in an explicit transaction;
- always pass through Bridge `WRITE`/`CRITICAL` policy;
- return `approval_required` before touching MySQL under secure-default policy;
- declare `retry: never`;
- return only normalized mutation summary fields such as `affectedRows`, `changedRows`, `insertId` and `warningStatus` when available;
- may declare `none`, `intrinsic` or `keyed` idempotency per profile.

A connection loss during mutation never triggers an automatic second execution.

### Configuration and credentials

Non-secret configuration contains:

```json
{
  "host": "db.example.com",
  "port": 3306,
  "database": "appdb",
  "tlsMode": "verify",
  "connectTimeoutMs": 5000
}
```

Credentials are resolved through `ConnectorSecretProvider`:

- `username`;
- `password`;
- optional `tls_ca` PEM CA bundle.

Verified TLS is the default. `tlsMode: "disabled"` only works when connector deployment explicitly enables `allowTlsDisabled`.

The constructor can also declare `allowedHosts`, an exact destination allowlist.

### Least privilege

Profiles constrain what agents can request, but the database account must still follow least privilege:

- a READ-only instance should use a read-only MySQL account;
- mutation profiles should receive only required table/operation permissions;
- destructive operations should be `CRITICAL` profiles with specific privileges;
- an administrative/root account should never be reused for Agent Bridge.

### ES/EN

The connector, setup and every profile require ES/EN metadata. Technical IDs, SQL, table/column names and security decisions remain locale-independent.

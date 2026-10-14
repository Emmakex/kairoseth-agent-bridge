import { isIP } from "node:net";

import type { RiskLevel } from "../../core/contracts.js";
import {
  ConnectorConfigurationError,
  ConnectorError,
  ConnectorTransientError,
} from "../sdk/errors.js";
import { requireConnectorSecret } from "../sdk/secrets.js";
import type {
  ConnectorDefinition,
  ConnectorHealthResult,
  ConnectorSecretProvider,
  ConnectorToolDefinition,
  JsonSchema,
} from "../sdk/contracts.js";
import type {
  MySqlBindableValue,
  MySqlConnectionSettings,
  MySqlConnectorOptions,
  MySqlExecutionResult,
  MySqlParameterType,
  MySqlProfile,
  MySqlProfileParameter,
  MySqlRuntime,
  ValidatedMySqlProfile,
} from "./contracts.js";
import { defaultMySqlRuntime } from "./runtime.js";

const MYSQL_REQUIREMENT_ID = "mysql_auth";
const USERNAME_FIELD = "username";
const PASSWORD_FIELD = "password";
const TLS_CA_FIELD = "tls_ca";
const DEFAULT_MAX_ROWS = 500;
const MAX_ROWS = 5_000;
const MAX_STATEMENT_LENGTH = 20_000;
const MAX_PARAMETERS = 64;
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const MAX_CONNECT_TIMEOUT_MS = 30_000;
const PROFILE_ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const PARAMETER_ID_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const BUILTIN_REDACT_KEYS = new Set([
  "password",
  "passwd",
  "secret",
  "token",
  "access_token",
  "refresh_token",
  "api_key",
  "apikey",
  "authorization",
  "cookie",
  "session",
  "private_key",
]);
const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "PROTOCOL_CONNECTION_LOST",
  "ER_LOCK_DEADLOCK",
  "ER_LOCK_WAIT_TIMEOUT",
  "ER_CON_COUNT_ERROR",
  "ER_TOO_MANY_USER_CONNECTIONS",
]);

export function createMySqlConnector(
  options: MySqlConnectorOptions,
  runtime: MySqlRuntime = defaultMySqlRuntime,
): ConnectorDefinition {
  const profiles = validateProfiles(options.profiles);
  const allowedHosts = normalizeAllowedHosts(options.allowedHosts);
  const tools = profiles.map((validated) =>
    profileTool(validated, options, allowedHosts, runtime),
  );

  return {
    manifest: {
      id: "mysql",
      name: "MySQL",
      version: "1.0.0",
      description:
        "Kairoseth connector for declared MySQL prepared-statement profiles without agent-supplied SQL.",
      localizations: {
        en: {
          name: "MySQL",
          description:
            "Kairoseth connector for declared MySQL prepared-statement profiles without agent-supplied SQL.",
        },
        es: {
          name: "MySQL",
          description:
            "Conector Kairoseth para perfiles MySQL declarados con prepared statements, sin SQL enviado por el agente.",
        },
      },
      capabilities: profileCapabilities(profiles),
      configSchema: {
        type: "object",
        properties: {
          host: {
            type: "string",
            minLength: 1,
            maxLength: 253,
            description: "MySQL server hostname or IP controlled by connector configuration.",
          },
          port: {
            type: "integer",
            minimum: 1,
            maximum: 65535,
            default: 3306,
          },
          database: {
            type: "string",
            minLength: 1,
            maxLength: 128,
          },
          tlsMode: {
            type: "string",
            enum: ["verify", "disabled"],
            default: "verify",
          },
          connectTimeoutMs: {
            type: "integer",
            minimum: 100,
            maximum: MAX_CONNECT_TIMEOUT_MS,
            default: DEFAULT_CONNECT_TIMEOUT_MS,
          },
        },
        required: ["host", "database"],
        additionalProperties: false,
      },
      credentials: [
        {
          id: MYSQL_REQUIREMENT_ID,
          kind: "database",
          label: "MySQL credentials",
          required: true,
          localizations: {
            en: {
              label: "MySQL credentials",
              description:
                "Database username/password and optional CA certificate. Use a least-privilege database account.",
            },
            es: {
              label: "Credenciales MySQL",
              description:
                "Usuario/contraseña de base de datos y CA opcional. Usa una cuenta de base de datos con privilegios mínimos.",
            },
          },
          fields: [
            {
              id: USERNAME_FIELD,
              label: "Username",
              secret: false,
              required: true,
              localizations: {
                en: { label: "Username" },
                es: { label: "Usuario" },
              },
            },
            {
              id: PASSWORD_FIELD,
              label: "Password",
              secret: true,
              required: true,
              localizations: {
                en: { label: "Password" },
                es: { label: "Contraseña" },
              },
            },
            {
              id: TLS_CA_FIELD,
              label: "TLS CA certificate",
              secret: false,
              required: false,
              localizations: {
                en: {
                  label: "TLS CA certificate",
                  description:
                    "Optional PEM CA bundle for verified TLS connections.",
                },
                es: {
                  label: "Certificado CA TLS",
                  description:
                    "Bundle CA PEM opcional para conexiones TLS verificadas.",
                },
              },
            },
          ],
        },
      ],
    },
    tools,
    health: async (context): Promise<ConnectorHealthResult> => {
      const checkedAt = new Date().toISOString();
      try {
        const settings = await resolveConnectionSettings(
          context.config,
          context.secrets,
          options,
          allowedHosts,
        );
        await runtime.health(settings, context.signal);
        return {
          status: "healthy",
          checkedAt,
          message: "MySQL connection and SELECT 1 health probe succeeded.",
        };
      } catch (error) {
        return {
          status: "unhealthy",
          checkedAt,
          message: `MySQL health check failed${safeDatabaseCodeSuffix(error)}.`,
        };
      }
    },
  };
}

function profileTool(
  validated: ValidatedMySqlProfile,
  options: MySqlConnectorOptions,
  allowedHosts: ReadonlySet<string> | undefined,
  runtime: MySqlRuntime,
): ConnectorToolDefinition {
  const { profile } = validated;
  const isRead = profile.risk === "READ";

  return {
    id: profile.id,
    name: profile.name,
    description: profile.description,
    localizations: profile.localizations,
    risk: profile.risk,
    inputSchema: validated.inputSchema,
    outputSchema: isRead ? readOutputSchema() : mutationOutputSchema(),
    behavior: {
      ...(profile.timeoutMs !== undefined ? { timeoutMs: profile.timeoutMs } : {}),
      retry: isRead
        ? {
            mode: "transient",
            maxAttempts: 3,
            baseDelayMs: 250,
            maxDelayMs: 2_000,
          }
        : { mode: "never" },
      ...(!isRead
        ? { idempotency: profile.idempotency ?? { mode: "none" as const } }
        : {}),
    },
    execute: async (input, context) => {
      const values = bindInput(validated, input);
      const settings = await resolveConnectionSettings(
        context.config,
        context.secrets,
        options,
        allowedHosts,
      );

      let result: MySqlExecutionResult;
      try {
        result = await runtime.execute(settings, {
          statement: validated.statement,
          values,
          mode: isRead ? "read" : "mutation",
          signal: context.signal,
        });
      } catch (error) {
        if (error instanceof ConnectorError) throw error;
        const suffix = safeDatabaseCodeSuffix(error);
        if (isRead && isTransientDatabaseError(error)) {
          throw new ConnectorTransientError(
            `MySQL READ profile ${profile.id} failed transiently${suffix}.`,
            { cause: error },
          );
        }
        throw new ConnectorError(
          `MySQL profile ${profile.id} failed${suffix}.`,
          { cause: error },
        );
      }

      if (isRead) {
        if (result.kind !== "rows") {
          throw new ConnectorError(
            `MySQL READ profile ${profile.id} returned a mutation result.`,
          );
        }
        if (result.rows.length > validated.maxRows) {
          throw new ConnectorError(
            `MySQL READ profile ${profile.id} exceeded its ${validated.maxRows}-row result bound.`,
          );
        }
        const rows = result.rows.map((row) =>
          redactValue(row, validated.redactColumns),
        );
        return { rows, rowCount: rows.length };
      }

      if (result.kind !== "mutation") {
        throw new ConnectorError(
          `MySQL mutation profile ${profile.id} returned a row set.`,
        );
      }
      return {
        affectedRows: result.affectedRows,
        changedRows: result.changedRows,
        ...(result.insertId !== undefined ? { insertId: result.insertId } : {}),
        ...(result.warningStatus !== undefined
          ? { warningStatus: result.warningStatus }
          : {}),
      };
    },
  };
}

function validateProfiles(
  profiles: readonly MySqlProfile[],
): readonly ValidatedMySqlProfile[] {
  if (!Array.isArray(profiles) || profiles.length === 0) {
    throw new ConnectorConfigurationError(
      "MySQL connector requires at least one declared profile.",
    );
  }
  if (profiles.length > 100) {
    throw new ConnectorConfigurationError(
      "MySQL connector supports at most 100 declared profiles.",
    );
  }

  const ids = new Set<string>();
  return profiles.map((profile) => {
    if (!PROFILE_ID_PATTERN.test(profile.id)) {
      throw new ConnectorConfigurationError(
        `MySQL profile id is invalid: ${profile.id}`,
      );
    }
    if (ids.has(profile.id)) {
      throw new ConnectorConfigurationError(
        `Duplicate MySQL profile id: ${profile.id}`,
      );
    }
    ids.add(profile.id);

    requireLocalizedProfileText(profile);
    const statement = validateStatement(profile);
    const inputSchema = profileInputSchema(profile.parameters);
    const maxRows = normalizeMaxRows(profile);
    const redactColumns = normalizeRedactColumns(profile.redactColumns);
    validateIdempotency(profile);
    validateProfileTimeout(profile.timeoutMs, profile.id);

    return {
      profile,
      statement,
      inputSchema,
      maxRows,
      redactColumns,
    };
  });
}

function validateStatement(profile: MySqlProfile): string {
  if (typeof profile.statement !== "string") {
    throw new ConnectorConfigurationError(
      `MySQL profile ${profile.id} statement must be a string.`,
    );
  }

  let statement = profile.statement.trim();
  if (!statement || statement.length > MAX_STATEMENT_LENGTH || statement.includes("\0")) {
    throw new ConnectorConfigurationError(
      `MySQL profile ${profile.id} statement is empty or exceeds ${MAX_STATEMENT_LENGTH} characters.`,
    );
  }
  if (statement.endsWith(";")) statement = statement.slice(0, -1).trimEnd();

  const structural = stripQuotedSql(statement);
  if (structural.includes(";") || /--|\/\*|\*\/|#/.test(structural)) {
    throw new ConnectorConfigurationError(
      `MySQL profile ${profile.id} cannot contain multiple statements or SQL comments.`,
    );
  }
  if (
    /\b(CREATE|ALTER|DROP|TRUNCATE|RENAME|GRANT|REVOKE|LOAD|HANDLER)\b/i.test(
      structural,
    ) ||
    /\bINTO\s+(OUTFILE|DUMPFILE)\b/i.test(structural)
  ) {
    throw new ConnectorConfigurationError(
      `MySQL profile ${profile.id} contains a prohibited SQL capability.`,
    );
  }

  const keyword = /^\s*([A-Za-z]+)/.exec(structural)?.[1]?.toUpperCase();
  if (profile.risk === "READ") {
    if (keyword !== "SELECT") {
      throw new ConnectorConfigurationError(
        `MySQL READ profile ${profile.id} must start with SELECT.`,
      );
    }
    if (!/\bLIMIT\b/i.test(structural)) {
      throw new ConnectorConfigurationError(
        `MySQL READ profile ${profile.id} must declare a LIMIT clause.`,
      );
    }
  } else {
    if (keyword !== "INSERT" && keyword !== "UPDATE" && keyword !== "DELETE") {
      throw new ConnectorConfigurationError(
        `MySQL mutation profile ${profile.id} must start with INSERT, UPDATE or DELETE.`,
      );
    }
    if (keyword === "DELETE" && profile.risk !== "CRITICAL") {
      throw new ConnectorConfigurationError(
        `MySQL DELETE profile ${profile.id} must be classified CRITICAL.`,
      );
    }
  }

  const placeholderCount = countPlaceholders(statement);
  if (profile.parameters.length !== placeholderCount) {
    throw new ConnectorConfigurationError(
      `MySQL profile ${profile.id} declares ${profile.parameters.length} parameters for ${placeholderCount} placeholders.`,
    );
  }
  validateParameters(profile.id, profile.parameters);
  return statement;
}

function validateParameters(
  profileId: string,
  parameters: readonly MySqlProfileParameter[],
): void {
  if (!Array.isArray(parameters) || parameters.length > MAX_PARAMETERS) {
    throw new ConnectorConfigurationError(
      `MySQL profile ${profileId} supports at most ${MAX_PARAMETERS} parameters.`,
    );
  }

  const ids = new Set<string>();
  for (const parameter of parameters) {
    if (!PARAMETER_ID_PATTERN.test(parameter.id)) {
      throw new ConnectorConfigurationError(
        `MySQL profile ${profileId} parameter id is invalid: ${parameter.id}`,
      );
    }
    if (ids.has(parameter.id)) {
      throw new ConnectorConfigurationError(
        `MySQL profile ${profileId} has duplicate parameter: ${parameter.id}`,
      );
    }
    ids.add(parameter.id);
    validateParameterConstraints(profileId, parameter);
  }
}

function validateParameterConstraints(
  profileId: string,
  parameter: MySqlProfileParameter,
): void {
  const numeric = parameter.type === "integer" || parameter.type === "number";
  if (!numeric && (parameter.minimum !== undefined || parameter.maximum !== undefined)) {
    throw new ConnectorConfigurationError(
      `MySQL profile ${profileId} parameter ${parameter.id} uses numeric bounds on a non-numeric type.`,
    );
  }
  if (parameter.type !== "string" && parameter.maxLength !== undefined) {
    throw new ConnectorConfigurationError(
      `MySQL profile ${profileId} parameter ${parameter.id} uses maxLength on a non-string type.`,
    );
  }
  if (
    parameter.minimum !== undefined &&
    parameter.maximum !== undefined &&
    parameter.minimum > parameter.maximum
  ) {
    throw new ConnectorConfigurationError(
      `MySQL profile ${profileId} parameter ${parameter.id} has invalid numeric bounds.`,
    );
  }
  if (
    parameter.maxLength !== undefined &&
    (!Number.isInteger(parameter.maxLength) ||
      parameter.maxLength < 1 ||
      parameter.maxLength > 10_000)
  ) {
    throw new ConnectorConfigurationError(
      `MySQL profile ${profileId} parameter ${parameter.id} maxLength is invalid.`,
    );
  }
}

function bindInput(
  validated: ValidatedMySqlProfile,
  input: unknown,
): readonly MySqlBindableValue[] {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ConnectorError(
      `MySQL profile ${validated.profile.id} input must be an object.`,
    );
  }
  const record = input as Record<string, unknown>;
  const allowed = new Set(validated.profile.parameters.map((parameter) => parameter.id));
  const unknown = Object.keys(record).find((key) => !allowed.has(key));
  if (unknown) {
    throw new ConnectorError(
      `MySQL profile ${validated.profile.id} contains unsupported field: ${unknown}.`,
    );
  }

  return validated.profile.parameters.map((parameter) => {
    const value = record[parameter.id];
    if (value === undefined) {
      if (parameter.required !== false) {
        throw new ConnectorError(
          `MySQL profile ${validated.profile.id} requires parameter: ${parameter.id}.`,
        );
      }
      return null;
    }
    return validateBindableValue(validated.profile.id, parameter, value);
  });
}

function validateBindableValue(
  profileId: string,
  parameter: MySqlProfileParameter,
  value: unknown,
): MySqlBindableValue {
  switch (parameter.type) {
    case "string": {
      if (typeof value !== "string") return invalidParameter(profileId, parameter);
      const maxLength = parameter.maxLength ?? 1_000;
      if (value.length > maxLength) return invalidParameter(profileId, parameter);
      return value;
    }
    case "integer": {
      if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        return invalidParameter(profileId, parameter);
      }
      validateNumericBounds(profileId, parameter, value);
      return value;
    }
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return invalidParameter(profileId, parameter);
      }
      validateNumericBounds(profileId, parameter, value);
      return value;
    }
    case "boolean":
      if (typeof value !== "boolean") return invalidParameter(profileId, parameter);
      return value;
    case "date":
      if (typeof value !== "string" || !isIsoDate(value)) {
        return invalidParameter(profileId, parameter);
      }
      return value;
    case "date-time":
      if (typeof value !== "string" || !isIsoDateTime(value)) {
        return invalidParameter(profileId, parameter);
      }
      return value;
  }
}

function invalidParameter(
  profileId: string,
  parameter: MySqlProfileParameter,
): never {
  throw new ConnectorError(
    `MySQL profile ${profileId} parameter ${parameter.id} is invalid for type ${parameter.type}.`,
  );
}

function validateNumericBounds(
  profileId: string,
  parameter: MySqlProfileParameter,
  value: number,
): void {
  if (parameter.minimum !== undefined && value < parameter.minimum) {
    invalidParameter(profileId, parameter);
  }
  if (parameter.maximum !== undefined && value > parameter.maximum) {
    invalidParameter(profileId, parameter);
  }
}

async function resolveConnectionSettings(
  config: Readonly<Record<string, unknown>>,
  secrets: ConnectorSecretProvider,
  options: MySqlConnectorOptions,
  allowedHosts: ReadonlySet<string> | undefined,
): Promise<MySqlConnectionSettings> {
  const host = normalizeHost(config.host);
  if (allowedHosts && !allowedHosts.has(normalizeHostKey(host))) {
    throw new ConnectorConfigurationError(
      `MySQL configured host is not allowlisted: ${host}`,
    );
  }
  const port = normalizeInteger(config.port, "port", 1, 65535, 3306);
  const database = normalizeDatabase(config.database);
  const connectTimeoutMs = normalizeInteger(
    config.connectTimeoutMs,
    "connectTimeoutMs",
    100,
    MAX_CONNECT_TIMEOUT_MS,
    DEFAULT_CONNECT_TIMEOUT_MS,
  );
  const tlsMode = normalizeTlsMode(config.tlsMode);
  if (tlsMode === "disabled" && !options.allowTlsDisabled) {
    throw new ConnectorConfigurationError(
      "MySQL TLS cannot be disabled unless the deployment explicitly allows it.",
    );
  }

  const username = await requireConnectorSecret(
    secrets,
    MYSQL_REQUIREMENT_ID,
    USERNAME_FIELD,
  );
  const password = await requireConnectorSecret(
    secrets,
    MYSQL_REQUIREMENT_ID,
    PASSWORD_FIELD,
  );
  const tlsCa = await secrets.getSecret(MYSQL_REQUIREMENT_ID, TLS_CA_FIELD);

  return {
    host,
    port,
    database,
    username,
    password,
    tlsMode,
    connectTimeoutMs,
    ...(tlsCa?.trim() ? { tlsCa: tlsCa.trim() } : {}),
  };
}

function profileInputSchema(
  parameters: readonly MySqlProfileParameter[],
): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];

  for (const parameter of parameters) {
    properties[parameter.id] = parameterSchema(parameter);
    if (parameter.required !== false) required.push(parameter.id);
  }

  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

function parameterSchema(parameter: MySqlProfileParameter): JsonSchema {
  const base: JsonSchema = {
    type: jsonSchemaType(parameter.type),
    ...(parameter.description ? { description: parameter.description } : {}),
  };
  if (parameter.minimum !== undefined) base.minimum = parameter.minimum;
  if (parameter.maximum !== undefined) base.maximum = parameter.maximum;
  if (parameter.maxLength !== undefined) base.maxLength = parameter.maxLength;
  if (parameter.type === "date") base.format = "date";
  if (parameter.type === "date-time") base.format = "date-time";
  return base;
}

function jsonSchemaType(type: MySqlParameterType): "string" | "integer" | "number" | "boolean" {
  if (type === "date" || type === "date-time") return "string";
  return type;
}

function readOutputSchema(): JsonSchema {
  return {
    type: "object",
    properties: {
      rows: {
        type: "array",
        items: { type: "object", additionalProperties: true },
      },
      rowCount: { type: "integer", minimum: 0 },
    },
    required: ["rows", "rowCount"],
    additionalProperties: false,
  };
}

function mutationOutputSchema(): JsonSchema {
  return {
    type: "object",
    properties: {
      affectedRows: { type: "integer", minimum: 0 },
      changedRows: { type: "integer", minimum: 0 },
      insertId: { type: "integer", minimum: 0 },
      warningStatus: { type: "integer", minimum: 0 },
    },
    required: ["affectedRows", "changedRows"],
    additionalProperties: false,
  };
}

function requireLocalizedProfileText(profile: MySqlProfile): void {
  for (const locale of ["es", "en"] as const) {
    const localized = profile.localizations[locale];
    if (!localized?.name.trim() || !localized.description.trim()) {
      throw new ConnectorConfigurationError(
        `MySQL profile ${profile.id} requires ${locale.toUpperCase()} name and description.`,
      );
    }
  }
  if (!profile.name.trim() || !profile.description.trim()) {
    throw new ConnectorConfigurationError(
      `MySQL profile ${profile.id} requires canonical name and description.`,
    );
  }
}

function validateIdempotency(profile: MySqlProfile): void {
  if (profile.risk === "READ") {
    if (profile.idempotency) {
      throw new ConnectorConfigurationError(
        `MySQL READ profile ${profile.id} must not declare mutation idempotency.`,
      );
    }
    return;
  }
  const policy = profile.idempotency;
  if (!policy || policy.mode !== "keyed") return;
  if (!policy.keyField) {
    throw new ConnectorConfigurationError(
      `MySQL profile ${profile.id} keyed idempotency requires keyField.`,
    );
  }
  const parameter = profile.parameters.find(
    (candidate) => candidate.id === policy.keyField,
  );
  if (!parameter || parameter.required === false) {
    throw new ConnectorConfigurationError(
      `MySQL profile ${profile.id} idempotency keyField must name a required parameter.`,
    );
  }
}

function normalizeMaxRows(profile: MySqlProfile): number {
  if (profile.risk !== "READ") {
    if (profile.maxRows !== undefined) {
      throw new ConnectorConfigurationError(
        `MySQL mutation profile ${profile.id} cannot declare maxRows.`,
      );
    }
    return 0;
  }
  const maxRows = profile.maxRows ?? DEFAULT_MAX_ROWS;
  if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > MAX_ROWS) {
    throw new ConnectorConfigurationError(
      `MySQL profile ${profile.id} maxRows must be between 1 and ${MAX_ROWS}.`,
    );
  }
  return maxRows;
}

function normalizeRedactColumns(
  values: readonly string[] | undefined,
): ReadonlySet<string> {
  const result = new Set(BUILTIN_REDACT_KEYS);
  for (const value of values ?? []) {
    const normalized = value.trim().toLowerCase();
    if (!normalized || normalized.length > 128) {
      throw new ConnectorConfigurationError(
        "MySQL redactColumns contains an invalid column name.",
      );
    }
    result.add(normalized);
  }
  return result;
}

function redactValue(value: unknown, redactKeys: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) return value.map((item) => redactValue(item, redactKeys));
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      result[key] = redactKeys.has(key.toLowerCase())
        ? "[REDACTED]"
        : redactValue(child, redactKeys);
    }
    return result;
  }
  return value;
}

function profileCapabilities(
  profiles: readonly ValidatedMySqlProfile[],
): readonly string[] {
  const capabilities = new Set<string>();
  for (const { profile } of profiles) {
    if (profile.risk === "READ") capabilities.add("profiles.read");
    if (profile.risk === "WRITE") capabilities.add("profiles.write");
    if (profile.risk === "CRITICAL") capabilities.add("profiles.critical");
  }
  return [...capabilities].sort();
}

function normalizeAllowedHosts(
  values: readonly string[] | undefined,
): ReadonlySet<string> | undefined {
  if (!values) return undefined;
  if (values.length === 0) {
    throw new ConnectorConfigurationError(
      "MySQL allowedHosts cannot be an empty list.",
    );
  }
  return new Set(values.map((value) => normalizeHostKey(normalizeHost(value))));
}

function normalizeHost(value: unknown): string {
  if (typeof value !== "string") {
    throw new ConnectorConfigurationError("MySQL host is required.");
  }
  const host = value.trim();
  if (!host || host.length > 253 || /[\s/@?#\\]/.test(host)) {
    throw new ConnectorConfigurationError("MySQL host is invalid.");
  }
  if (isIP(host)) return host;
  const normalized = host.replace(/\.$/, "");
  if (
    !normalized ||
    !normalized.split(".").every((label) =>
      /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label),
    )
  ) {
    throw new ConnectorConfigurationError("MySQL host is invalid.");
  }
  return normalized;
}

function normalizeHostKey(host: string): string {
  return host.toLowerCase().replace(/\.$/, "");
}

function normalizeDatabase(value: unknown): string {
  if (typeof value !== "string") {
    throw new ConnectorConfigurationError("MySQL database is required.");
  }
  const database = value.trim();
  if (!database || database.length > 128 || /[\u0000-\u001f\u007f]/.test(database)) {
    throw new ConnectorConfigurationError("MySQL database is invalid.");
  }
  return database;
}

function normalizeTlsMode(value: unknown): "verify" | "disabled" {
  if (value === undefined) return "verify";
  if (value === "verify" || value === "disabled") return value;
  throw new ConnectorConfigurationError("MySQL tlsMode is invalid.");
}

function normalizeInteger(
  value: unknown,
  field: string,
  min: number,
  max: number,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new ConnectorConfigurationError(
      `MySQL ${field} must be an integer between ${min} and ${max}.`,
    );
  }
  return value;
}

function validateProfileTimeout(value: number | undefined, profileId: string): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < 100 || value > 300_000) {
    throw new ConnectorConfigurationError(
      `MySQL profile ${profileId} timeoutMs must be between 100 and 300000.`,
    );
  }
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function isIsoDateTime(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value)) return false;
  return Number.isFinite(Date.parse(value));
}

function stripQuotedSql(statement: string): string {
  let output = "";
  let quote: "'" | '"' | "`" | undefined;

  for (let index = 0; index < statement.length; index += 1) {
    const char = statement[index] ?? "";
    if (quote) {
      if (char === "\\") {
        output += "  ";
        index += 1;
        continue;
      }
      if (char === quote) {
        if (statement[index + 1] === quote) {
          output += "  ";
          index += 1;
          continue;
        }
        quote = undefined;
      }
      output += " ";
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      output += " ";
      continue;
    }
    output += char;
  }

  if (quote) {
    throw new ConnectorConfigurationError("MySQL profile contains an unterminated SQL quote.");
  }
  return output;
}

function countPlaceholders(statement: string): number {
  const structural = stripQuotedSql(statement);
  let count = 0;
  for (const char of structural) {
    if (char === "?") count += 1;
  }
  return count;
}

function isTransientDatabaseError(error: unknown): boolean {
  return TRANSIENT_CODES.has(databaseErrorCode(error) ?? "");
}

function databaseErrorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const code = (error as Record<string, unknown>).code;
  return typeof code === "string" && /^[A-Z0-9_]{2,64}$/.test(code)
    ? code
    : undefined;
}

function safeDatabaseCodeSuffix(error: unknown): string {
  const code = databaseErrorCode(error);
  return code ? ` (${code})` : "";
}

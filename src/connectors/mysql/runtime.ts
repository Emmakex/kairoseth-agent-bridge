import mysql from "mysql2/promise";

import { ConnectorError } from "../sdk/errors.js";
import type {
  MySqlConnectionSettings,
  MySqlExecutionRequest,
  MySqlExecutionResult,
  MySqlMutationResult,
  MySqlRuntime,
} from "./contracts.js";

export const defaultMySqlRuntime: MySqlRuntime = {
  async execute(settings, request) {
    const connection = await mysql.createConnection(connectionOptions(settings));
    let transactionOpen = false;
    const abort = () => connection.destroy();

    if (request.signal.aborted) {
      connection.destroy();
      throw new ConnectorError("MySQL execution was aborted before it started.");
    }
    request.signal.addEventListener("abort", abort, { once: true });

    try {
      if (request.mode === "read") {
        await connection.query("START TRANSACTION READ ONLY");
      } else {
        await connection.beginTransaction();
      }
      transactionOpen = true;

      const [raw] = await connection.execute(
        request.statement,
        [...request.values],
      );

      let result: MySqlExecutionResult;
      if (request.mode === "read") {
        result = {
          kind: "rows",
          rows: normalizeRows(raw),
        };
        await connection.rollback();
      } else {
        result = normalizeMutation(raw);
        await connection.commit();
      }
      transactionOpen = false;
      return result;
    } catch (error) {
      if (transactionOpen) {
        await connection.rollback().catch(() => undefined);
      }
      throw error;
    } finally {
      request.signal.removeEventListener("abort", abort);
      await connection.end().catch(() => undefined);
    }
  },

  async health(settings, signal) {
    const connection = await mysql.createConnection(connectionOptions(settings));
    const abort = () => connection.destroy();

    if (signal.aborted) {
      connection.destroy();
      throw new ConnectorError("MySQL health check was aborted before it started.");
    }
    signal.addEventListener("abort", abort, { once: true });

    try {
      await connection.execute("SELECT 1 AS ok");
    } finally {
      signal.removeEventListener("abort", abort);
      await connection.end().catch(() => undefined);
    }
  },
};

function connectionOptions(settings: MySqlConnectionSettings) {
  return {
    host: settings.host,
    port: settings.port,
    database: settings.database,
    user: settings.username,
    password: settings.password,
    connectTimeout: settings.connectTimeoutMs,
    charset: "utf8mb4",
    multipleStatements: false,
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: true,
    ...(settings.tlsMode === "verify"
      ? {
          ssl: {
            rejectUnauthorized: true,
            ...(settings.tlsCa ? { ca: settings.tlsCa } : {}),
          },
        }
      : {}),
  };
}

function normalizeRows(raw: unknown): readonly Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(raw)) {
    throw new ConnectorError("MySQL READ profile did not return a row set.");
  }

  return raw.map((row) => {
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      throw new ConnectorError("MySQL READ profile returned an unsupported row shape.");
    }

    const normalized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
      normalized[key] = normalizeDbValue(value);
    }
    return normalized;
  });
}

function normalizeMutation(raw: unknown): MySqlMutationResult {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConnectorError("MySQL mutation profile returned an unsupported result shape.");
  }

  const record = raw as Record<string, unknown>;
  const affectedRows = requireNonNegativeInteger(record.affectedRows, "affectedRows");
  const changedRows = optionalNonNegativeInteger(record.changedRows) ?? affectedRows;
  const insertId = optionalNonNegativeInteger(record.insertId);
  const warningStatus = optionalNonNegativeInteger(record.warningStatus);

  return {
    kind: "mutation",
    affectedRows,
    changedRows,
    ...(insertId !== undefined ? { insertId } : {}),
    ...(warningStatus !== undefined ? { warningStatus } : {}),
  };
}

function normalizeDbValue(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) {
    return { encoding: "base64", data: value.toString("base64") };
  }
  if (Array.isArray(value)) return value.map(normalizeDbValue);
  if (value !== null && typeof value === "object") {
    const normalized: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      normalized[key] = normalizeDbValue(child);
    }
    return normalized;
  }
  return value;
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ConnectorError(`MySQL result ${field} is invalid.`);
  }
  return value;
}

function optionalNonNegativeInteger(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  return requireNonNegativeInteger(value, "numeric field");
}

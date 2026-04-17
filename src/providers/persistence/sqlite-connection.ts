import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { AgentProbeConfigError } from "../../shared/utils/errors.ts";
import { redactDbUrl } from "./url.ts";

export const DEFAULT_DB_DIRNAME = ".agentprobe";
export const DEFAULT_DB_FILENAME = "runs.sqlite3";

function ensureDirectory(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

/**
 * Resolve a `sqlite:///path` URL (or undefined for default path) into an absolute
 * filesystem path. Creates the parent directory if needed.
 */
export function resolveSqlitePath(dbUrl?: string): string {
  if (!dbUrl) {
    const defaultPath = resolve(DEFAULT_DB_DIRNAME, DEFAULT_DB_FILENAME);
    ensureDirectory(defaultPath);
    return defaultPath;
  }
  if (!dbUrl.startsWith("sqlite:///")) {
    throw new AgentProbeConfigError(
      `Unsupported sqlite db url: ${redactDbUrl(dbUrl)}`,
    );
  }
  const path = dbUrl.slice("sqlite:///".length);
  ensureDirectory(path);
  return path;
}

export function openSqliteDatabase(path: string): Database {
  const database = new Database(path);
  database.exec("pragma foreign_keys = on;");
  try {
    database.exec("pragma journal_mode = WAL;");
  } catch {
    // Some SQLite targets may not support WAL; writes still work without it.
  }
  return database;
}

export function withSqliteDatabase<T>(
  path: string,
  fn: (database: Database) => T,
): T {
  const database = openSqliteDatabase(path);
  try {
    return fn(database);
  } finally {
    database.close();
  }
}

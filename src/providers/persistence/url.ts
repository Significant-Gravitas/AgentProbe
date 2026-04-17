import { resolve } from "node:path";

import { AgentProbeConfigError } from "../../shared/utils/errors.ts";
import type { ParsedDbUrl, PersistenceBackendKind } from "./types.ts";

export const DEFAULT_DB_DIRNAME = ".agentprobe";
export const DEFAULT_DB_FILENAME = "runs.sqlite3";

export function defaultSqliteDbUrl(): string {
  return `sqlite:///${resolve(DEFAULT_DB_DIRNAME, DEFAULT_DB_FILENAME)}`;
}

const URL_SCHEME_RE = /^([A-Za-z][A-Za-z\d+.-]*:\/\/)(.*)$/;

function redactUserinfoFallback(dbUrl: string): string {
  const match = URL_SCHEME_RE.exec(dbUrl);
  if (!match) {
    return dbUrl;
  }

  const [, scheme, afterScheme] = match;
  const atIndex = afterScheme.lastIndexOf("@");
  if (atIndex === -1) {
    return dbUrl;
  }

  const userinfo = afterScheme.slice(0, atIndex);
  const passwordSeparatorIndex = userinfo.indexOf(":");
  if (passwordSeparatorIndex === -1) {
    return dbUrl;
  }

  const user = userinfo.slice(0, passwordSeparatorIndex);
  const rest = afterScheme.slice(atIndex + 1);
  return `${scheme}${user}:***@${rest}`;
}

/** Redact `user:password@host` to `user:***@host` for logging. */
export function redactDbUrl(dbUrl: string): string {
  if (!dbUrl) {
    return dbUrl;
  }

  try {
    const url = new URL(dbUrl);
    if (url.password) {
      url.password = "***";
    }
    return url.toString();
  } catch {
    return redactUserinfoFallback(dbUrl);
  }
}

/** Parse a db URL into a normalized descriptor with backend kind and redacted display URL. */
export function parseDbUrl(rawUrl: string): ParsedDbUrl {
  if (typeof rawUrl !== "string" || rawUrl.trim() === "") {
    throw new AgentProbeConfigError("Database URL must be a non-empty string.");
  }
  const trimmed = rawUrl.trim();
  let kind: PersistenceBackendKind;
  if (trimmed.startsWith("sqlite://")) {
    kind = "sqlite";
  } else if (
    trimmed.startsWith("postgres://") ||
    trimmed.startsWith("postgresql://")
  ) {
    kind = "postgres";
  } else {
    throw new AgentProbeConfigError(
      `Unsupported database URL scheme: ${redactDbUrl(trimmed)}. ` +
        "Expected `sqlite:///path/to.db`, `postgres://…`, or `postgresql://…`.",
    );
  }
  return {
    kind,
    displayUrl: redactDbUrl(trimmed),
    rawUrl: trimmed,
  };
}

/** Return `true` if the URL points to Postgres. Used when only the scheme matters. */
export function isPostgresUrl(rawUrl: string): boolean {
  return rawUrl.startsWith("postgres://") || rawUrl.startsWith("postgresql://");
}

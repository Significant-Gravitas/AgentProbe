import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

import {
  DEFAULT_DB_DIRNAME,
  DEFAULT_DB_FILENAME,
} from "../../providers/persistence/sqlite-run-history.ts";
import { POSTGRES_RUN_RECORDING_UNSUPPORTED_MESSAGE } from "../../providers/persistence/types.ts";
import { isPostgresUrl, redactDbUrl } from "../../providers/persistence/url.ts";
import { AgentProbeConfigError } from "../../shared/utils/errors.ts";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 7878;
export const DEFAULT_DASHBOARD_DIST = "dashboard/dist";

export type LogFormat = "text" | "json";

export type ServerConfig = {
  host: string;
  port: number;
  dataPath: string;
  dbUrl: string;
  dashboardDist?: string;
  token?: string;
  corsOrigins: string[];
  unsafeExpose: boolean;
  openBrowser: boolean;
  logFormat: LogFormat;
};

type ParsedFlags = {
  host?: string;
  port?: number;
  data?: string;
  db?: string;
  dbUrl?: string;
  dashboardDist?: string;
  token?: string;
  corsOrigins?: string[];
  unsafeExpose?: boolean;
  open?: boolean;
  logFormat?: LogFormat;
};

type FlagSource = {
  args: string[];
  env?: Record<string, string | undefined>;
};

function parseOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new AgentProbeConfigError(`${name} requires a value.`);
  }
  return value;
}

function parseFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function parsePort(
  raw: string | undefined,
  source: string,
): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new AgentProbeConfigError(
      `${source} must be an integer between 0 and 65535 (got \`${raw}\`).`,
    );
  }
  return port;
}

function parseBoolean(raw: string | undefined): boolean | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off", ""].includes(normalized)) {
    return false;
  }
  return undefined;
}

function parseLogFormat(
  raw: string | undefined,
  source: string,
): LogFormat | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (raw === "text" || raw === "json") {
    return raw;
  }
  throw new AgentProbeConfigError(
    `${source} must be "text" or "json" (got \`${raw}\`).`,
  );
}

function parseCorsOrigins(raw: string | undefined): string[] | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const origins = raw
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  const normalized = origins.map((origin) => {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new AgentProbeConfigError(
        `AGENTPROBE_SERVER_CORS_ORIGINS contains an invalid origin: ${origin}.`,
      );
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new AgentProbeConfigError(
        `AGENTPROBE_SERVER_CORS_ORIGINS origins must use http or https (got \`${origin}\`).`,
      );
    }
    if (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") {
      throw new AgentProbeConfigError(
        `AGENTPROBE_SERVER_CORS_ORIGINS entries must be origins without paths, queries, or fragments (got \`${origin}\`).`,
      );
    }
    return parsed.origin;
  });
  return [...new Set(normalized)];
}

function parseDbFlag(args: string[]): {
  dbPath?: string;
  dbUrl?: string;
} {
  const raw = parseOption(args, "--db");
  if (raw === undefined) {
    return {};
  }
  if (
    raw.startsWith("sqlite://") ||
    raw.startsWith("postgres://") ||
    raw.startsWith("postgresql://")
  ) {
    return { dbUrl: raw };
  }
  return { dbPath: raw };
}

function readCliFlags(args: string[]): ParsedFlags {
  const port = parsePort(parseOption(args, "--port"), "--port");
  const unsafeExpose = parseFlag(args, "--unsafe-expose");
  const openBrowser = parseFlag(args, "--open");
  const { dbPath, dbUrl } = parseDbFlag(args);
  const token = parseOption(args, "--token");
  const logFormat = parseLogFormat(
    parseOption(args, "--log-format"),
    "--log-format",
  );
  return {
    host: parseOption(args, "--host"),
    port,
    data: parseOption(args, "--data"),
    db: dbPath,
    dbUrl,
    dashboardDist: parseOption(args, "--dashboard-dist"),
    token,
    unsafeExpose: unsafeExpose ? true : undefined,
    open: openBrowser ? true : undefined,
    logFormat,
  };
}

function readEnvFlags(env: Record<string, string | undefined>): ParsedFlags {
  const port = parsePort(env.AGENTPROBE_SERVER_PORT, "AGENTPROBE_SERVER_PORT");
  const logFormat = parseLogFormat(
    env.AGENTPROBE_SERVER_LOG_FORMAT,
    "AGENTPROBE_SERVER_LOG_FORMAT",
  );
  const unsafeExpose = parseBoolean(env.AGENTPROBE_SERVER_UNSAFE_EXPOSE);
  const corsOrigins = parseCorsOrigins(env.AGENTPROBE_SERVER_CORS_ORIGINS);

  const dbUrlEnv = env.AGENTPROBE_DB_URL;
  const dbEnv = env.AGENTPROBE_SERVER_DB;
  let dbPath: string | undefined;
  let dbUrl: string | undefined;
  if (dbUrlEnv) {
    dbUrl = dbUrlEnv;
  }
  if (dbEnv && !dbUrl) {
    if (
      dbEnv.startsWith("sqlite://") ||
      dbEnv.startsWith("postgres://") ||
      dbEnv.startsWith("postgresql://")
    ) {
      dbUrl = dbEnv;
    } else {
      dbPath = dbEnv;
    }
  }

  return {
    host: env.AGENTPROBE_SERVER_HOST,
    port,
    data: env.AGENTPROBE_SERVER_DATA,
    db: dbPath,
    dbUrl,
    dashboardDist: env.AGENTPROBE_SERVER_DASHBOARD_DIST,
    token: env.AGENTPROBE_SERVER_TOKEN,
    corsOrigins,
    unsafeExpose,
    logFormat,
  };
}

function merge<T>(
  primary: T | undefined,
  fallback: T | undefined,
): T | undefined {
  return primary !== undefined ? primary : fallback;
}

function normalizeDbUrl(
  dbFlag: string | undefined,
  dbUrlFlag: string | undefined,
): string {
  if (dbUrlFlag) {
    if (
      dbUrlFlag.startsWith("postgres://") ||
      dbUrlFlag.startsWith("postgresql://") ||
      dbUrlFlag.startsWith("sqlite://")
    ) {
      return dbUrlFlag;
    }
    throw new AgentProbeConfigError(
      `Unsupported database URL: ${redactDbUrl(dbUrlFlag)}. Expected \`sqlite://\`, \`postgres://\`, or \`postgresql://\`.`,
    );
  }
  if (dbFlag) {
    return `sqlite:///${resolve(dbFlag)}`;
  }
  return `sqlite:///${resolve(DEFAULT_DB_DIRNAME, DEFAULT_DB_FILENAME)}`;
}

function assertDirectoryExists(path: string, label: string): void {
  const resolved = resolve(path);
  if (!existsSync(resolved)) {
    throw new AgentProbeConfigError(`${label} not found: ${resolved}`);
  }
  if (!statSync(resolved).isDirectory()) {
    throw new AgentProbeConfigError(
      `${label} must be a directory (got a file): ${resolved}`,
    );
  }
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  if (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "[::1]"
  ) {
    return true;
  }
  const parts = normalized.split(".");
  if (parts.length !== 4 || parts[0] !== "127") {
    return false;
  }
  return parts.every((part) => {
    if (!/^\d+$/.test(part)) {
      return false;
    }
    const value = Number(part);
    return Number.isInteger(value) && value >= 0 && value <= 255;
  });
}

function defaultDashboardDist(): string | undefined {
  const candidate = resolve(DEFAULT_DASHBOARD_DIST);
  return existsSync(candidate) && statSync(candidate).isDirectory()
    ? candidate
    : undefined;
}

export function buildServerConfig(source: FlagSource): ServerConfig {
  const env = source.env ?? {};
  const cli = readCliFlags(source.args);
  const envFlags = readEnvFlags(env);

  const host = merge(cli.host, envFlags.host) ?? DEFAULT_HOST;
  const port = merge(cli.port, envFlags.port) ?? DEFAULT_PORT;
  const dataPath = merge(cli.data, envFlags.data) ?? "data";
  const configuredDashboardDist = merge(
    cli.dashboardDist,
    envFlags.dashboardDist,
  );
  const dashboardDist = configuredDashboardDist ?? defaultDashboardDist();
  const token = merge(cli.token, envFlags.token);
  const corsOrigins = envFlags.corsOrigins ?? [];
  const unsafeExpose = Boolean(merge(cli.unsafeExpose, envFlags.unsafeExpose));
  const openBrowser = Boolean(cli.open);
  const logFormat = merge(cli.logFormat, envFlags.logFormat) ?? "text";

  assertDirectoryExists(dataPath, "--data directory");
  if (configuredDashboardDist && dashboardDist) {
    assertDirectoryExists(dashboardDist, "--dashboard-dist directory");
  }

  const dbUrl = normalizeDbUrl(
    merge(cli.db, envFlags.db),
    merge(cli.dbUrl, envFlags.dbUrl),
  );
  if (isPostgresUrl(dbUrl)) {
    throw new AgentProbeConfigError(POSTGRES_RUN_RECORDING_UNSUPPORTED_MESSAGE);
  }

  if (!isLoopbackHost(host)) {
    if (!unsafeExpose) {
      throw new AgentProbeConfigError(
        `Refusing to bind to non-loopback host \`${host}\` without --unsafe-expose.`,
      );
    }
    if (!token || token.trim().length === 0) {
      throw new AgentProbeConfigError(
        `--unsafe-expose requires an authentication token (set --token or AGENTPROBE_SERVER_TOKEN).`,
      );
    }
  }
  if (unsafeExpose && corsOrigins.length === 0) {
    throw new AgentProbeConfigError(
      `--unsafe-expose requires explicit CORS origins (set AGENTPROBE_SERVER_CORS_ORIGINS).`,
    );
  }

  return {
    host,
    port,
    dataPath: resolve(dataPath),
    dbUrl,
    dashboardDist: dashboardDist ? resolve(dashboardDist) : undefined,
    token: token?.trim() ? token : undefined,
    corsOrigins,
    unsafeExpose,
    openBrowser,
    logFormat,
  };
}

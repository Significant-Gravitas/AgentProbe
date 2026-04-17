import { redactDbUrl } from "../../../providers/persistence/url.ts";
import type { ServerConfig } from "../config.ts";

const REDACTED = "[redacted]";
const SECRET_KEY_PATTERN =
  /(token|secret|key|password|authorization|api[_-]?key)/i;

export function redactSecretValue(value: string | undefined | null): string {
  if (value === undefined || value === null || value === "") {
    return "";
  }
  if (value.length <= 4) {
    return REDACTED;
  }
  return `${REDACTED}:${value.length}c`;
}

export function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

export function redactRecord(
  record: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string" && isSecretKey(key)) {
      out[key] = redactSecretValue(value);
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      out[key] = redactRecord(value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function summarizeServerConfig(
  config: ServerConfig,
): Record<string, unknown> {
  return {
    host: config.host,
    port: config.port,
    data_path: config.dataPath,
    db_url: redactDbUrl(config.dbUrl),
    dashboard_dist: config.dashboardDist ?? null,
    token: config.token ? redactSecretValue(config.token) : null,
    cors_origins: config.corsOrigins,
    unsafe_expose: config.unsafeExpose,
    open_browser: config.openBrowser,
    log_format: config.logFormat,
  };
}

import type { LogFormat } from "../config.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Record<string, unknown>;

export type Logger = {
  log(level: LogLevel, event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  child(component: string, baseFields?: LogFields): Logger;
};

type Sink = (line: string) => void;

const LEVEL_LABEL: Record<LogLevel, string> = {
  debug: "debug",
  info: "info",
  warn: "warn",
  error: "error",
};

function defaultSink(line: string): void {
  process.stderr.write(`${line}\n`);
}

function formatText(
  level: LogLevel,
  component: string,
  event: string,
  fields: LogFields,
): string {
  const parts: string[] = [`[${component}]`, `${LEVEL_LABEL[level]}`, event];
  for (const [key, value] of Object.entries(fields)) {
    parts.push(`${key}=${formatTextValue(value)}`);
  }
  return parts.join(" ");
}

function formatTextValue(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "string") {
    return value.includes(" ") ? `"${value.replace(/"/g, '\\"')}"` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

export function createLogger(options: {
  component: string;
  format: LogFormat;
  baseFields?: LogFields;
  sink?: Sink;
}): Logger {
  const sink = options.sink ?? defaultSink;
  const baseFields = { ...(options.baseFields ?? {}) };
  const component = options.component;
  const format = options.format;

  const log = (
    level: LogLevel,
    event: string,
    fields: LogFields = {},
  ): void => {
    const merged = { ...baseFields, ...fields };
    if (format === "json") {
      const payload = {
        ts: new Date().toISOString(),
        level: LEVEL_LABEL[level],
        component,
        event,
        ...merged,
      };
      sink(JSON.stringify(payload));
    } else {
      sink(formatText(level, component, event, merged));
    }
  };

  return {
    log,
    info: (event, fields) => log("info", event, fields),
    warn: (event, fields) => log("warn", event, fields),
    error: (event, fields) => log("error", event, fields),
    child(childComponent: string, childFields?: LogFields): Logger {
      return createLogger({
        component: childComponent,
        format,
        baseFields: { ...baseFields, ...(childFields ?? {}) },
        sink,
      });
    },
  };
}

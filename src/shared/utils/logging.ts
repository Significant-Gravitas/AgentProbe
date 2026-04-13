type AgentProbeLogLevel = "warn" | "info" | "debug";

const priorityByLevel: Record<AgentProbeLogLevel, number> = {
  warn: 0,
  info: 1,
  debug: 2,
};

function resolvedLevel(): AgentProbeLogLevel {
  const raw = Bun.env.AGENTPROBE_LOG_LEVEL?.trim().toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn") {
    return raw;
  }
  return "warn";
}

function shouldLog(level: AgentProbeLogLevel): boolean {
  return priorityByLevel[resolvedLevel()] >= priorityByLevel[level];
}

function timestamp(): string {
  return new Date().toISOString().slice(11, 19);
}

function writeLog(level: AgentProbeLogLevel, args: unknown[]): void {
  if (!shouldLog(level)) {
    return;
  }
  console.error(`[${timestamp()}] ${level.toUpperCase()}`, ...args);
}

export function setLogLevel(level: AgentProbeLogLevel): void {
  Bun.env.AGENTPROBE_LOG_LEVEL = level;
}

export function logWarn(...args: unknown[]): void {
  writeLog("warn", args);
}

export function logInfo(...args: unknown[]): void {
  writeLog("info", args);
}

export function logDebug(...args: unknown[]): void {
  writeLog("debug", args);
}

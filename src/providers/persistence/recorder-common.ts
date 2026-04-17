import { createHash } from "node:crypto";
import { resolve } from "node:path";

import type { JsonValue, Rubric } from "../../shared/types/contracts.ts";

export const REDACTED_VALUE = "[REDACTED]";

const sensitiveExactKeys = new Set([
  "access_token",
  "api_key",
  "api-key",
  "authorization",
  "client_secret",
  "cookie",
  "header_value",
  "id_token",
  "password",
  "refresh_token",
  "secret",
  "session_token",
  "set-cookie",
  "token",
  "x-api-key",
]);

const sensitiveSuffixes = [
  "_token",
  "_secret",
  "_password",
  "_cookie",
  "_apikey",
  "_api_key",
];

export function utcNow(): string {
  return new Date().toISOString();
}

export function shouldRedactKey(key: string): boolean {
  const lowered = key.toLowerCase();
  return (
    sensitiveExactKeys.has(lowered) ||
    sensitiveSuffixes.some((suffix) => lowered.endsWith(suffix))
  );
}

export function redactValue(value: unknown, parentKey?: string): JsonValue {
  if (parentKey && shouldRedactKey(parentKey)) {
    return REDACTED_VALUE;
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value as JsonValue;
  }
  if (value === undefined) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, parentKey));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([_key, item]) => item !== undefined)
        .map(([key, item]) => [key, redactValue(item, key)]),
    );
  }
  return String(value);
}

function normalizeValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (value === undefined) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeValue(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([_key, item]) => item !== undefined)
        .map(([key, item]) => [key, normalizeValue(item)]),
    );
  }
  return String(value);
}

export function hashValue(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(normalizeValue(value)))
    .digest("hex");
}

export function filtersPayload(options: {
  scenarioFilter?: string;
  tags?: string;
}): Record<string, JsonValue> {
  return {
    scenario_id: options.scenarioFilter ?? null,
    tags: options.tags ?? null,
  };
}

export function sourcePathsPayload(options: {
  endpoint: string;
  scenarios: string;
  personas: string;
  rubric: string;
}): Record<string, string> {
  return {
    endpoint: resolve(options.endpoint),
    scenarios: resolve(options.scenarios),
    personas: resolve(options.personas),
    rubric: resolve(options.rubric),
  };
}

export function runStatusForExitCode(exitCode: number): string {
  if (exitCode === 2) {
    return "config_error";
  }
  if (exitCode === 3) {
    return "runtime_error";
  }
  return "error";
}

export function scenarioStatusForError(error: Error): string {
  return error.name === "AgentProbeRuntimeError" ? "runtime_error" : "error";
}

export function normalizedDimensionScore(
  rubric: Rubric,
  dimensionId: string,
  rawScore: number,
): number {
  const dimension = rubric.dimensions.find((item) => item.id === dimensionId);
  const scalePoints = dimension?.scale.points ?? 1;
  return rawScore / scalePoints;
}

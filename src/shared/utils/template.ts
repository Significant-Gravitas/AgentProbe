import nunjucks from "nunjucks";

import { AgentProbeConfigError } from "./errors.ts";

const envPattern = /\$\{([^}:]+)(?:(:-|:\?)([^}]*))?\}/g;

const templateEnvironment = new nunjucks.Environment(undefined, {
  autoescape: false,
  throwOnUndefined: true,
  trimBlocks: true,
  lstripBlocks: true,
});

templateEnvironment.addFilter("tojson", (value: unknown) =>
  JSON.stringify(value),
);

function toSnakeCase(value: string): string {
  return value
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replaceAll(/[-\s]+/g, "_")
    .toLowerCase();
}

function toCamelCase(value: string): string {
  return value.replaceAll(/[_-]([a-z])/g, (_match, letter: string) =>
    letter.toUpperCase(),
  );
}

function addTemplateAliases<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if (Array.isArray(value)) {
    return value.map((item) => addTemplateAliases(item, seen)) as T;
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const cached = seen.get(value as object);
  if (cached) {
    return cached as T;
  }

  const result: Record<string, unknown> = {};
  seen.set(value as object, result);

  for (const [key, item] of Object.entries(value)) {
    const normalized = addTemplateAliases(item, seen);
    result[key] = normalized;

    const snakeKey = toSnakeCase(key);
    if (!(snakeKey in result)) {
      result[snakeKey] = normalized;
    }

    const camelKey = toCamelCase(key);
    if (!(camelKey in result)) {
      result[camelKey] = normalized;
    }
  }

  return result as T;
}

export function resolveEnvInString(value: string): string {
  return value.replace(envPattern, (_match, rawName, rawOperator, rawOperand) => {
    const name = String(rawName);
    const operator = typeof rawOperator === "string" ? rawOperator : "";
    const operand = typeof rawOperand === "string" ? rawOperand : "";
    const envValue = Bun.env[name];

    if (envValue !== undefined && envValue !== "") {
      return envValue;
    }
    if (operator === ":-") {
      return operand;
    }
    if (operator === ":?") {
      throw new AgentProbeConfigError(
        operand || `Environment variable ${name} is required.`,
      );
    }
    throw new AgentProbeConfigError(
      `Environment variable ${name} is required.`,
    );
  });
}

export function resolveEnvInValue<T>(value: T): T {
  if (typeof value === "string") {
    return resolveEnvInString(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveEnvInValue(item)) as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, resolveEnvInValue(item)]),
    ) as T;
  }
  return value;
}

export function renderTemplate(
  template: string,
  context: Record<string, unknown>,
): string {
  try {
    return templateEnvironment.renderString(
      template,
      addTemplateAliases(context),
    );
  } catch (error) {
    throw new AgentProbeConfigError(
      `Template rendering failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export function renderOptionalTemplate(
  template: string | undefined,
  context: Record<string, unknown>,
): string | undefined {
  if (template === undefined) {
    return undefined;
  }
  return renderTemplate(template, context);
}

export function renderJsonTemplate(
  template: string | undefined,
  context: Record<string, unknown>,
): unknown {
  const rendered = renderOptionalTemplate(template, context);
  if (rendered === undefined) {
    return undefined;
  }

  const stripped = rendered.trim();
  if (!stripped) {
    return undefined;
  }

  try {
    return JSON.parse(stripped) as unknown;
  } catch {
    return rendered;
  }
}

export function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

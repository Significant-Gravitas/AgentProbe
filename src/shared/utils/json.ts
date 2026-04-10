import { AgentProbeConfigError } from "./errors.ts";

function normalizePropertyName(raw: string): string {
  return raw.trim().replace(/^["']|["']$/g, "");
}

function tokenizeJsonPath(expr: string): Array<
  | { type: "root" }
  | { type: "property"; name: string }
  | { type: "filter"; property: string; equals: string }
> {
  const trimmed = expr.trim();
  if (!trimmed.startsWith("$")) {
    throw new AgentProbeConfigError(`Invalid JSONPath \`${expr}\`: must start with $.`);
  }

  const tokens: Array<
    | { type: "root" }
    | { type: "property"; name: string }
    | { type: "filter"; property: string; equals: string }
  > = [{ type: "root" }];

  let index = 1;
  while (index < trimmed.length) {
    const char = trimmed[index];
    if (char === ".") {
      index += 1;
      let end = index;
      while (end < trimmed.length && /[A-Za-z0-9_]/.test(trimmed[end] ?? "")) {
        end += 1;
      }
      const name = trimmed.slice(index, end);
      if (!name) {
        throw new AgentProbeConfigError(`Invalid JSONPath \`${expr}\`.`);
      }
      tokens.push({ type: "property", name });
      index = end;
      continue;
    }

    if (trimmed.startsWith("[?(@.", index)) {
      const close = trimmed.indexOf(")]", index);
      if (close === -1) {
        throw new AgentProbeConfigError(`Invalid JSONPath \`${expr}\`.`);
      }

      const condition = trimmed.slice(index + 5, close);
      const [rawProp, rawValue] = condition.split("==");
      if (!rawProp || rawValue === undefined) {
        throw new AgentProbeConfigError(`Invalid JSONPath \`${expr}\`.`);
      }
      tokens.push({
        type: "filter",
        property: normalizePropertyName(rawProp),
        equals: normalizePropertyName(rawValue),
      });
      index = close + 2;
      continue;
    }

    throw new AgentProbeConfigError(`Invalid JSONPath \`${expr}\`.`);
  }

  return tokens;
}

export function extractJsonPathMatches(payload: unknown, expr: string): unknown[] {
  if (expr.trim() === "$") {
    return [payload];
  }

  const tokens = tokenizeJsonPath(expr);
  let current: unknown[] = [payload];

  for (const token of tokens.slice(1)) {
    if (token.type === "property") {
      current = current.flatMap((item) => {
        if (item === null || typeof item !== "object") {
          return [];
        }

        if (Array.isArray(item)) {
          return item.flatMap((entry) => {
            if (entry === null || typeof entry !== "object") {
              return [];
            }
            return token.name in entry
              ? [(entry as Record<string, unknown>)[token.name]]
              : [];
          });
        }

        return token.name in item
          ? [(item as Record<string, unknown>)[token.name]]
          : [];
      });
      continue;
    }

    if (token.type === "filter") {
      current = current.flatMap((item) => {
        if (!Array.isArray(item)) {
          return [];
        }
        return item.filter((entry) => {
          if (entry === null || typeof entry !== "object") {
            return false;
          }
          const value = (entry as Record<string, unknown>)[token.property];
          return typeof value === "string"
            ? value === token.equals
            : String(value) === token.equals;
        });
      });
    }
  }

  return current;
}

export function extractFirstJsonPathMatch(
  payload: unknown,
  expr: string,
): unknown | null {
  const matches = extractJsonPathMatches(payload, expr);
  return matches[0] ?? null;
}

export function flattenTextChunks(value: unknown): string[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return [String(value)];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => flattenTextChunks(item));
  }
  return [JSON.stringify(value)];
}

export function extractTextByJsonPath(payload: unknown, expr: string): string {
  const matches = extractJsonPathMatches(payload, expr);
  return flattenTextChunks(matches).join("\n").trim();
}

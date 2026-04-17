import type { ScenarioSelectionRef } from "../../shared/types/contracts.ts";

export class HttpInputError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "HttpInputError";
    this.status = status;
    this.code = code;
  }
}

export type ParallelRequest = {
  enabled: boolean;
  limit?: number;
};

export async function readJsonObject(
  request: Request,
): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new HttpInputError(400, "bad_request", "Request body must be JSON.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpInputError(
      400,
      "bad_request",
      "Request body must be a JSON object.",
    );
  }
  return body as Record<string, unknown>;
}

export async function readOptionalJsonObject(
  request: Request,
): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (!text.trim()) {
    return {};
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HttpInputError(400, "bad_request", "Request body must be JSON.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpInputError(
      400,
      "bad_request",
      "Request body must be a JSON object.",
    );
  }
  return body as Record<string, unknown>;
}

export function optionalString(
  body: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpInputError(400, "bad_request", `${key} must be a string.`);
  }
  return value.trim();
}

export function requiredString(
  body: Record<string, unknown>,
  key: string,
): string {
  const value = optionalString(body, key);
  if (!value) {
    throw new HttpInputError(400, "bad_request", `${key} is required.`);
  }
  return value;
}

export function optionalBoolean(
  body: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = body[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new HttpInputError(400, "bad_request", `${key} must be boolean.`);
  }
  return value;
}

export function optionalPositiveInteger(
  body: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = body[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new HttpInputError(
      400,
      "bad_request",
      `${key} must be a positive integer.`,
    );
  }
  return Number(value);
}

export function optionalParallel(
  body: Record<string, unknown>,
  key = "parallel",
): ParallelRequest | undefined {
  const value = body[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "boolean") {
    return { enabled: value };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpInputError(
      400,
      "bad_request",
      `${key} must be a boolean or object.`,
    );
  }
  const raw = value as Record<string, unknown>;
  const enabled = raw.enabled;
  const limit = raw.limit;
  if (enabled !== undefined && typeof enabled !== "boolean") {
    throw new HttpInputError(
      400,
      "bad_request",
      `${key}.enabled must be boolean.`,
    );
  }
  if (
    limit !== undefined &&
    limit !== null &&
    (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1)
  ) {
    throw new HttpInputError(
      400,
      "bad_request",
      `${key}.limit must be a positive integer.`,
    );
  }
  return {
    enabled: enabled === true || limit !== undefined,
    limit: limit === undefined || limit === null ? undefined : Number(limit),
  };
}

export function requiredSelection(
  body: Record<string, unknown>,
  key = "selection",
): ScenarioSelectionRef[] {
  const value = body[key];
  if (!Array.isArray(value) || value.length === 0) {
    throw new HttpInputError(
      400,
      "bad_request",
      `${key} must be a non-empty array.`,
    );
  }
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new HttpInputError(
        400,
        "bad_request",
        `${key}[${index}] must be an object.`,
      );
    }
    const raw = item as Record<string, unknown>;
    const file = typeof raw.file === "string" ? raw.file.trim() : "";
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    if (!file || !id) {
      throw new HttpInputError(
        400,
        "bad_request",
        `${key}[${index}] requires file and id.`,
      );
    }
    return { file, id };
  });
}

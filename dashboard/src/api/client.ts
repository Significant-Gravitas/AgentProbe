import { useCallback } from "react";
import type { ServerRequest } from "./types.ts";

/** Soft budget for logging only — no requests are aborted at this threshold. */
export const DEFAULT_BUDGET_MS = 300;

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export class BudgetExceededError extends Error {
  constructor(
    readonly path: string,
    readonly budgetMs: number,
  ) {
    super(`Request to ${path} exceeded ${budgetMs}ms budget`);
    this.name = "BudgetExceededError";
  }
}

export interface ApiOptions extends RequestInit {
  /**
   * Soft budget for telemetry. Logged in dev when exceeded; never aborts the
   * request. Pass a number to override per-call, or `Infinity` to silence
   * the warning entirely. Defaults to {@link DEFAULT_BUDGET_MS}.
   */
  budgetMs?: number;
  /**
   * Hard deadline. When set, the request is aborted on timeout and a
   * {@link BudgetExceededError} is thrown. Default is no timeout.
   */
  timeoutMs?: number;
}

function errorMessageFromBody(body: unknown, fallback: string): string {
  if (!body || typeof body !== "object") return fallback;
  const error = (body as Record<string, unknown>).error;
  if (!error || typeof error !== "object") return fallback;
  const message = (error as Record<string, unknown>).message;
  return typeof message === "string" && message ? message : fallback;
}

function composeSignals(
  caller: AbortSignal | null | undefined,
  timeoutMs: number | undefined,
): { signal: AbortSignal | undefined; timeout: AbortSignal | null } {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) {
    return { signal: caller ?? undefined, timeout: null };
  }
  const timeout = AbortSignal.timeout(timeoutMs);
  const signals: AbortSignal[] = [timeout];
  if (caller) signals.push(caller);
  return { signal: AbortSignal.any(signals), timeout };
}

export async function api<T>(path: string, init: ApiOptions = {}): Promise<T> {
  const { budgetMs = DEFAULT_BUDGET_MS, timeoutMs, signal, ...rest } = init;
  const headers: Record<string, string> = { accept: "application/json" };
  const incomingHeaders = new Headers(rest.headers);
  for (const [key, value] of incomingHeaders.entries()) {
    headers[key] = value;
  }

  const { signal: composed, timeout } = composeSignals(signal, timeoutMs);
  const start = performance.now();
  let response: Response;
  try {
    response = await fetch(path, { ...rest, headers, signal: composed });
  } catch (error) {
    if (timeout?.aborted && timeoutMs !== undefined) {
      throw new BudgetExceededError(path, timeoutMs);
    }
    throw error;
  }

  const elapsed = performance.now() - start;
  if (import.meta.env.DEV && Number.isFinite(budgetMs) && elapsed > budgetMs) {
    const serverTiming = response.headers.get("server-timing");
    console.warn(
      `[budget] ${path} took ${elapsed.toFixed(0)}ms (budget ${budgetMs}ms)` +
        (serverTiming ? `\n  server-timing: ${serverTiming}` : ""),
    );
  }

  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!response.ok) {
    throw new ApiError(
      response.status,
      errorMessageFromBody(body, `HTTP ${response.status}`),
    );
  }
  return body as T;
}

export function jsonBody(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

export function useServerRequest(): ServerRequest {
  return useCallback(async <T>(path: string, init?: ApiOptions): Promise<T> => {
    return await api<T>(path, init);
  }, []);
}

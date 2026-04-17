import { randomUUID } from "node:crypto";

export type ErrorEnvelope = {
  error: {
    code: string;
    type: string;
    message: string;
    request_id: string;
    details: Record<string, never>;
  };
};

type ServerHeaders = Record<string, string> | Array<[string, string]>;

type JsonResponseInit = Omit<ResponseInit, "headers"> & {
  headers?: ServerHeaders;
  requestId: string;
};

export function jsonResponse(body: unknown, init: JsonResponseInit): Response {
  const { requestId, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json; charset=utf-8");
  }
  headers.set("x-request-id", requestId);
  return new Response(JSON.stringify(body), {
    ...rest,
    headers,
  });
}

export function errorResponse(options: {
  status: number;
  type: string;
  message: string;
  requestId: string;
  headers?: ServerHeaders;
}): Response {
  const envelope: ErrorEnvelope = {
    error: {
      code: options.type,
      type: options.type,
      message: options.message,
      request_id: options.requestId,
      details: {},
    },
  };
  return jsonResponse(envelope, {
    status: options.status,
    headers: options.headers,
    requestId: options.requestId,
  });
}

export function ensureRequestId(request: Request): string {
  const incoming = request.headers.get("x-request-id");
  if (incoming?.trim()) {
    return incoming.trim();
  }
  return randomUUID();
}

export function parsePositiveInt(
  raw: string | null,
  fallback: number,
  max: number,
): number {
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    return fallback;
  }
  return Math.min(value, max);
}

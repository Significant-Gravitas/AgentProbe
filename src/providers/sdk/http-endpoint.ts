import { readFile } from "node:fs/promises";

import type {
  AdapterReply,
  AutogptAuthResult,
  EndpointRequest,
  Endpoints,
  HealthCheck,
  JsonValue,
  SessionLifecycleRequest,
  ToolCallRecord,
  UploadedFile,
} from "../../shared/types/contracts.ts";
import {
  AgentProbeConfigError,
  AgentProbeRuntimeError,
} from "../../shared/utils/errors.ts";
import {
  extractFirstJsonPathMatch,
  extractTextByJsonPath,
} from "../../shared/utils/json.ts";
import {
  renderJsonTemplate,
  renderTemplate,
} from "../../shared/utils/template.ts";
import { resolveAuth } from "./autogpt-auth.ts";
import { dispatchKey } from "./preset-config.ts";

type Fetcher = typeof fetch;

type ResolvedRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  jsonBody?: unknown;
  content?: string;
};

function parseSseEvents(lines: string[]): unknown[] {
  const events: unknown[] = [];
  const dataLines: string[] = [];

  const flush = (): void => {
    if (dataLines.length === 0) {
      return;
    }
    const payload = dataLines.join("\n").trim();
    dataLines.length = 0;
    if (!payload || payload === "[DONE]") {
      return;
    }
    try {
      events.push(JSON.parse(payload));
    } catch {
      events.push({ data: payload });
    }
  };

  for (const line of lines) {
    const stripped = line.trim();
    if (!stripped) {
      flush();
      continue;
    }
    if (stripped.startsWith(":")) {
      continue;
    }
    const separatorIndex = stripped.indexOf(":");
    const field =
      separatorIndex === -1 ? stripped : stripped.slice(0, separatorIndex);
    const value =
      separatorIndex === -1
        ? ""
        : stripped.slice(separatorIndex + 1).trimStart();
    if (field === "data") {
      dataLines.push(value ?? "");
    }
  }
  flush();
  return events;
}

function extractUsage(payload: unknown): Record<string, JsonValue> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {};
  }
  const usage = (payload as Record<string, unknown>).usage;
  return usage && typeof usage === "object" && !Array.isArray(usage)
    ? (usage as Record<string, JsonValue>)
    : {};
}

function parseToolArgs(argumentsValue: unknown): Record<string, JsonValue> {
  if (
    argumentsValue &&
    typeof argumentsValue === "object" &&
    !Array.isArray(argumentsValue)
  ) {
    return argumentsValue as Record<string, JsonValue>;
  }
  if (typeof argumentsValue === "string" && argumentsValue.trim()) {
    try {
      const parsed = JSON.parse(argumentsValue) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, JsonValue>;
      }
      return { value: parsed as JsonValue };
    } catch {
      return { raw: argumentsValue };
    }
  }
  return {};
}

function parseJsonValue(value: unknown): JsonValue {
  if (typeof value !== "string") {
    return (value ?? null) as JsonValue;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return value;
  }
  try {
    return JSON.parse(trimmed) as JsonValue;
  } catch {
    return value;
  }
}

function normalizeToolCall(rawCall: unknown): ToolCallRecord | undefined {
  if (!rawCall || typeof rawCall !== "object" || Array.isArray(rawCall)) {
    return undefined;
  }
  const record = rawCall as Record<string, unknown>;
  const fn = record.function;
  const name =
    fn && typeof fn === "object" && !Array.isArray(fn)
      ? (fn as Record<string, unknown>).name
      : record.name;
  const args =
    fn && typeof fn === "object" && !Array.isArray(fn)
      ? (fn as Record<string, unknown>).arguments
      : (record.input ?? record.args);
  if (typeof name !== "string" || !name.trim()) {
    return undefined;
  }
  return {
    name,
    args: parseToolArgs(args),
    raw: record as Record<string, JsonValue>,
  };
}

function extractOpenAiToolCalls(payload: unknown): ToolCallRecord[] {
  const list = Array.isArray(payload) ? payload : [payload];
  const calls: ToolCallRecord[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const record = item as Record<string, unknown>;
    if (Array.isArray(record.tool_calls)) {
      for (const rawCall of record.tool_calls) {
        const normalized = normalizeToolCall(rawCall);
        if (normalized) {
          normalized.order = calls.length + 1;
          calls.push(normalized);
        }
      }
    }
    const choices = record.choices;
    if (!Array.isArray(choices)) {
      continue;
    }
    for (const choice of choices) {
      if (!choice || typeof choice !== "object" || Array.isArray(choice)) {
        continue;
      }
      for (const key of ["message", "delta"] as const) {
        const target = (choice as Record<string, unknown>)[key];
        if (!target || typeof target !== "object" || Array.isArray(target)) {
          continue;
        }
        const nested = (target as Record<string, unknown>).tool_calls;
        if (!Array.isArray(nested)) {
          continue;
        }
        for (const rawCall of nested) {
          const normalized = normalizeToolCall(rawCall);
          if (normalized) {
            normalized.order = calls.length + 1;
            calls.push(normalized);
          }
        }
      }
    }
  }
  return calls;
}

function extractAnthropicToolCalls(payload: unknown): ToolCallRecord[] {
  const list = Array.isArray(payload) ? payload : [payload];
  const calls: ToolCallRecord[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const block of content) {
      if (!block || typeof block !== "object" || Array.isArray(block)) {
        continue;
      }
      if ((block as Record<string, unknown>).type !== "tool_use") {
        continue;
      }
      const normalized = normalizeToolCall(block);
      if (normalized) {
        normalized.order = calls.length + 1;
        calls.push(normalized);
      }
    }
  }
  return calls;
}

function extractAutogptToolCalls(payload: unknown): ToolCallRecord[] {
  const events = Array.isArray(payload) ? payload : [payload];
  const calls: ToolCallRecord[] = [];
  const byToolCallId = new Map<string, ToolCallRecord>();

  const ensureCall = (
    record: Record<string, unknown>,
  ): ToolCallRecord | undefined => {
    const toolCallId =
      typeof record.toolCallId === "string" && record.toolCallId.trim()
        ? record.toolCallId
        : undefined;
    const toolName =
      typeof record.toolName === "string" && record.toolName.trim()
        ? record.toolName
        : undefined;

    if (toolCallId) {
      const existing = byToolCallId.get(toolCallId);
      if (existing) {
        if (toolName) {
          existing.name = toolName;
        }
        return existing;
      }

      const created: ToolCallRecord = {
        name: toolName ?? "",
        args: {},
        order: calls.length + 1,
        raw: {
          tool_call_id: toolCallId,
        },
      };
      byToolCallId.set(toolCallId, created);
      calls.push(created);
      return created;
    }

    if (!toolName) {
      return undefined;
    }

    const created: ToolCallRecord = {
      name: toolName,
      args: {},
      order: calls.length + 1,
      raw: {},
    };
    calls.push(created);
    return created;
  };

  for (const event of events) {
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      continue;
    }

    const record = event as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : "";
    if (!type.startsWith("tool-")) {
      continue;
    }

    const toolCall = ensureCall(record);
    if (!toolCall) {
      continue;
    }

    toolCall.raw ??= {};
    if (type === "tool-input-start") {
      toolCall.raw.input_start = record as Record<string, JsonValue>;
      continue;
    }

    if (type === "tool-input-available") {
      toolCall.args = parseToolArgs(record.input);
      toolCall.raw.input_event = record as Record<string, JsonValue>;
      continue;
    }

    if (type === "tool-output-available") {
      toolCall.raw.output_event = record as Record<string, JsonValue>;
      toolCall.raw.output = parseJsonValue(record.output);
    }
  }

  return calls.filter((toolCall) => toolCall.name.trim().length > 0);
}

function extractConfiguredToolCalls(
  payload: unknown,
  endpoint: Endpoints,
): ToolCallRecord[] {
  if (endpoint.toolExtraction?.format === "openai") {
    return extractOpenAiToolCalls(payload);
  }
  if (endpoint.toolExtraction?.format === "anthropic") {
    return extractAnthropicToolCalls(payload);
  }
  if (endpoint.toolExtraction?.format === "custom") {
    const key = dispatchKey(endpoint);
    if (
      key &&
      ["autogpt", "autogpt-endpoint.yaml", "autogpt-endpoint.yml"].includes(key)
    ) {
      return extractAutogptToolCalls(payload);
    }
  }
  return [];
}

export class HttpEndpointAdapter {
  private cachedAuthHeaders?: Record<string, string>;

  constructor(
    readonly endpoint: Endpoints,
    private readonly fetchImpl: Fetcher = fetch,
    private readonly autogptAuthResolver:
      | (() => Promise<AutogptAuthResult> | AutogptAuthResult)
      | undefined = undefined,
  ) {
    if (endpoint.transport !== "http") {
      throw new AgentProbeConfigError("HTTP adapter requires transport: http.");
    }
    if (!endpoint.connection || !("baseUrl" in endpoint.connection)) {
      throw new AgentProbeConfigError(
        "HTTP adapter requires an HTTP connection.",
      );
    }
  }

  async healthCheck(renderContext: Record<string, unknown>): Promise<void> {
    const healthCheck = this.endpoint.healthCheck;
    if (!healthCheck || healthCheck.enabled === false) {
      return;
    }
    const request = await this.resolveRequestDefinition(
      healthCheck,
      renderContext,
    );
    const response = await this.fetch(request);
    if (!response.ok) {
      throw new AgentProbeRuntimeError(
        `Health check failed (${response.status}) for ${request.url}.`,
      );
    }
  }

  async openScenario(
    renderContext: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const session = this.endpoint.session;
    if (!session || session.type === "stateless") {
      return {};
    }
    if (session.type !== "managed" || !session.create) {
      throw new AgentProbeConfigError(
        "HTTP runner only supports stateless and managed sessions.",
      );
    }

    const request = await this.resolveRequestDefinition(
      session.create,
      renderContext,
    );
    const response = await this.fetch(request);
    if (!response.ok) {
      throw new AgentProbeRuntimeError(
        `Managed session create failed (${response.status}) for ${request.url}.`,
      );
    }
    const payload = (await response.json()) as unknown;
    const sessionState: Record<string, unknown> = {};
    if (session.create.sessionIdPath) {
      const sessionId = extractFirstJsonPathMatch(
        payload,
        session.create.sessionIdPath,
      );
      if (sessionId === null || sessionId === undefined) {
        throw new AgentProbeRuntimeError(
          "Managed session create response did not contain a session id.",
        );
      }
      sessionState.session_id = String(sessionId);
    }
    if (session.create.sessionTokenPath) {
      const sessionToken = extractFirstJsonPathMatch(
        payload,
        session.create.sessionTokenPath,
      );
      if (sessionToken !== null && sessionToken !== undefined) {
        sessionState.session_token = String(sessionToken);
      }
    }
    return sessionState;
  }

  async sendUserTurn(
    renderContext: Record<string, unknown>,
  ): Promise<AdapterReply> {
    if (!this.endpoint.request) {
      throw new AgentProbeConfigError(
        "Endpoint is missing request configuration.",
      );
    }
    if (!this.endpoint.response) {
      throw new AgentProbeConfigError(
        "Endpoint is missing response configuration.",
      );
    }

    const request = await this.resolveRequestDefinition(
      this.endpoint.request,
      renderContext,
    );
    const startedAt = performance.now();
    const response = await this.fetch(request);
    if (!response.ok) {
      throw new AgentProbeRuntimeError(
        `Endpoint request failed (${response.status}) for ${request.url}.`,
      );
    }

    const responseConfig = this.endpoint.response;
    let assistantText = "";
    let toolCalls: ToolCallRecord[] = [];
    let usage: Record<string, JsonValue> = {};
    let rawBody: unknown;

    if (responseConfig.format === "sse") {
      const lines = (await response.text()).split(/\r?\n/);
      const events = parseSseEvents(lines);
      assistantText = events
        .map((event) =>
          extractTextByJsonPath(event, responseConfig.contentPath),
        )
        .filter(Boolean)
        .join("\n")
        .trim();
      rawBody = events;
      usage = events.length > 0 ? extractUsage(events.at(-1)) : {};
      toolCalls = extractConfiguredToolCalls(events, this.endpoint);
    } else if (responseConfig.format === "json") {
      const payload = (await response.json()) as unknown;
      assistantText = extractTextByJsonPath(
        payload,
        responseConfig.contentPath,
      );
      rawBody = payload;
      usage = extractUsage(payload);
      toolCalls = extractConfiguredToolCalls(payload, this.endpoint);
    } else {
      const text = await response.text();
      assistantText = text.trim();
      rawBody = text;
    }

    return {
      assistantText,
      toolCalls,
      rawExchange: {
        request: {
          method: request.method,
          url: request.url,
          headers: request.headers,
          json_body: (request.jsonBody ?? null) as JsonValue,
          content: (request.content ?? null) as JsonValue,
        },
        response: {
          status_code: response.status,
          headers: Object.fromEntries(response.headers.entries()) as Record<
            string,
            JsonValue
          >,
          body: (rawBody ?? null) as JsonValue,
        },
      },
      latencyMs: performance.now() - startedAt,
      usage,
    };
  }

  async uploadFile(filePath: string, fileName: string): Promise<UploadedFile> {
    const connection = this.endpoint.connection;
    if (!connection || !("baseUrl" in connection)) {
      throw new AgentProbeConfigError(
        "File upload requires an HTTP connection with base_url.",
      );
    }
    const baseUrl = connection.baseUrl.replace(/\/$/, "");
    const authHeaders = await this.resolveAuthHeaders();
    const fileBytes = await readFile(filePath);
    const blob = new Blob([fileBytes]);
    const form = new FormData();
    form.append("file", blob, fileName);
    const response = await this.fetchImpl(
      `${baseUrl}/api/workspace/files/upload`,
      {
        method: "POST",
        headers: authHeaders,
        body: form,
      },
    );
    if (!response.ok) {
      throw new AgentProbeRuntimeError(
        `File upload failed (${response.status}) for ${fileName}.`,
      );
    }
    const body = (await response.json()) as Record<string, unknown>;
    return {
      fileId: String(body.file_id ?? body.id ?? ""),
      name: String(body.name ?? fileName),
      mimeType: typeof body.mime_type === "string" ? body.mime_type : undefined,
    };
  }

  async closeScenario(renderContext: Record<string, unknown>): Promise<void> {
    const closeRequest = this.endpoint.session?.close;
    if (!closeRequest) {
      return;
    }
    const request = await this.resolveRequestDefinition(
      closeRequest,
      renderContext,
    );
    const response = await this.fetch(request);
    if (!response.ok && closeRequest.ignoreErrors !== true) {
      throw new AgentProbeRuntimeError(
        `Managed session close failed (${response.status}) for ${request.url}.`,
      );
    }
  }

  private async fetch(request: ResolvedRequest): Promise<Response> {
    return await this.fetchImpl(request.url, {
      method: request.method,
      headers: request.headers,
      body:
        request.content ??
        (request.jsonBody !== undefined
          ? JSON.stringify(request.jsonBody)
          : undefined),
    });
  }

  private async resolveRequestDefinition(
    requestLike: EndpointRequest | SessionLifecycleRequest | HealthCheck,
    renderContext: Record<string, unknown>,
  ): Promise<ResolvedRequest> {
    const connection = this.endpoint.connection;
    if (!connection || !("baseUrl" in connection)) {
      throw new AgentProbeConfigError("HTTP adapter requires baseUrl.");
    }

    const endpointName = (requestLike as { endpoint?: string }).endpoint;
    const namedEndpoint = endpointName
      ? this.endpoint.endpoints[endpointName]
      : undefined;
    if (endpointName && !namedEndpoint) {
      throw new AgentProbeConfigError(
        `Unknown named endpoint: ${endpointName}`,
      );
    }

    const method =
      (requestLike as { method?: string }).method ?? namedEndpoint?.method;
    const urlTemplate =
      (requestLike as { url?: string }).url ?? namedEndpoint?.url;
    const bodyTemplate =
      (requestLike as { bodyTemplate?: string }).bodyTemplate ??
      namedEndpoint?.bodyTemplate;

    if (!method || !urlTemplate) {
      throw new AgentProbeConfigError(
        "HTTP request definition must include method and url.",
      );
    }

    const context = {
      ...renderContext,
      base_url: connection.baseUrl,
      baseUrl: connection.baseUrl,
    };
    const headers = {
      ...(namedEndpoint?.headers ?? {}),
      ...(await this.resolveAuthHeaders()),
    };

    const renderedHeaders = Object.fromEntries(
      Object.entries(headers).map(([key, value]) => [
        key,
        renderTemplate(value, context),
      ]),
    );

    const url = renderTemplate(urlTemplate, context);
    const renderedBody = renderJsonTemplate(bodyTemplate, context);

    return typeof renderedBody === "string"
      ? {
          method,
          url,
          headers: renderedHeaders,
          content: renderedBody,
        }
      : {
          method,
          url,
          headers: renderedHeaders,
          jsonBody: renderedBody,
        };
  }

  private async resolveAuthHeaders(): Promise<Record<string, string>> {
    const auth = this.endpoint.auth;
    if (!auth || auth.type === "none") {
      return await this.resolveInternalAuthHeaders();
    }
    if (auth.type === "header") {
      if (!auth.headerName || auth.headerValue === undefined) {
        throw new AgentProbeConfigError(
          "Header auth requires header_name and header_value.",
        );
      }
      return { [auth.headerName]: auth.headerValue };
    }
    if (auth.type === "bearer_token") {
      if (!auth.token) {
        throw new AgentProbeConfigError("Bearer token auth requires token.");
      }
      return { Authorization: `Bearer ${auth.token}` };
    }
    throw new AgentProbeConfigError(
      `Unsupported auth type for HTTP adapter: ${auth.type}`,
    );
  }

  private async resolveInternalAuthHeaders(): Promise<Record<string, string>> {
    if (this.cachedAuthHeaders) {
      return { ...this.cachedAuthHeaders };
    }
    const key = dispatchKey(this.endpoint);
    if (
      !key ||
      !["autogpt", "autogpt-endpoint.yaml", "autogpt-endpoint.yml"].includes(
        key,
      )
    ) {
      this.cachedAuthHeaders = {};
      return {};
    }
    try {
      const resolved = this.autogptAuthResolver
        ? await this.autogptAuthResolver()
        : await resolveAuth();
      this.cachedAuthHeaders = { ...resolved.headers };
      return { ...this.cachedAuthHeaders };
    } catch (error) {
      throw new AgentProbeRuntimeError(
        `AutoGPT auth failed: ${
          error instanceof Error ? error.message : String(error)
        }. Verify the backend is running at the configured URL (AUTOGPT_BACKEND_URL or default http://localhost:8006) and that AUTOGPT_JWT_SECRET is set correctly.`,
      );
    }
  }
}

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type {
  JsonValue,
  OpenAiResponsesRequest,
  OpenAiResponsesResponse,
} from "../../shared/types/contracts.ts";
import {
  AgentProbeConfigError,
  AgentProbeRuntimeError,
} from "../../shared/utils/errors.ts";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_RETRY_BASE_MS = 500;
const DEFAULT_RETRY_MAX_MS = 8000;

function readPositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function computeBackoffMs(
  attempt: number,
  baseMs: number,
  maxMs: number,
): number {
  const exponential = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  const jitter = Math.random() * exponential;
  return Math.max(0, Math.floor(jitter));
}

function isRetryableStatus(status: number): boolean {
  return (
    status === 408 ||
    status === 409 ||
    status === 425 ||
    status === 429 ||
    status >= 500
  );
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export class OpenAiResponsesApiError extends AgentProbeRuntimeError {
  constructor(
    message: string,
    readonly statusCode?: number,
    readonly responseBody?: string,
  ) {
    super(message);
  }
}

export class OpenAiResponsesAuthenticationError extends OpenAiResponsesApiError {
  override name = "OpenAiResponsesAuthenticationError";
}

type FakeRule = {
  name?: string;
  kind?: string;
  inputContains?: unknown[];
  instructionsContains?: unknown[];
  output?: unknown;
};

function normalizeJson(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeJson(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, normalizeJson(item)]),
    );
  }
  return String(value);
}

function appendFakeLog(
  path: string | undefined,
  record: Record<string, JsonValue>,
): void {
  if (!path) {
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  const line = `${JSON.stringify(record)}\n`;
  writeFileSync(path, line, { encoding: "utf8", flag: "a" });
}

function loadFakeRules(path: string | undefined): FakeRule[] {
  if (!path || !existsSync(path)) {
    return [];
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { rules?: unknown };
  return Array.isArray(parsed.rules) ? (parsed.rules as FakeRule[]) : [];
}

function flattenInputText(request: OpenAiResponsesRequest): string {
  if (typeof request.input === "string") {
    return request.input;
  }
  return request.input
    .flatMap((message) => message.content.map((part) => part.text))
    .join("\n\n");
}

function serializeInput(request: OpenAiResponsesRequest): unknown {
  if (typeof request.input === "string") {
    return request.input;
  }
  return request.input.map((message) => ({
    type: message.type,
    role: message.role,
    content: message.content.map((part) => ({
      type: part.type,
      text: part.text,
    })),
  }));
}

function matchFakeRule(
  request: OpenAiResponsesRequest,
  rules: FakeRule[],
): FakeRule {
  const kind = request.text.format.name;
  const inputText = flattenInputText(request);
  for (const rule of rules) {
    if ((rule.kind ?? "") !== kind) {
      continue;
    }
    const inputContains = Array.isArray(rule.inputContains)
      ? rule.inputContains
      : [];
    if (inputContains.some((item) => !inputText.includes(String(item)))) {
      continue;
    }
    const instructionsContains = Array.isArray(rule.instructionsContains)
      ? rule.instructionsContains
      : [];
    if (
      instructionsContains.some(
        (item) => !request.instructions.includes(String(item)),
      )
    ) {
      continue;
    }
    return rule;
  }
  throw new AgentProbeRuntimeError(
    `No fake OpenAI response matched the request. kind='${kind}' input='${inputText}'`,
  );
}

export class OpenAiResponsesClient {
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly fakeScriptPath?: string;
  private readonly fakeLogPath?: string;
  private readonly fakeRules: FakeRule[];
  private readonly maxAttempts: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;

  constructor() {
    this.apiKey = Bun.env.OPEN_ROUTER_API_KEY?.trim();
    this.baseUrl = OPENROUTER_BASE_URL;
    this.fakeScriptPath = Bun.env.AGENTPROBE_E2E_OPENAI_SCRIPT?.trim();
    this.fakeLogPath = Bun.env.AGENTPROBE_E2E_OPENAI_LOG?.trim();
    this.fakeRules = loadFakeRules(this.fakeScriptPath);
    this.maxAttempts = readPositiveInt(
      Bun.env.AGENTPROBE_OPENROUTER_MAX_ATTEMPTS,
      DEFAULT_MAX_ATTEMPTS,
    );
    this.retryBaseMs = readPositiveInt(
      Bun.env.AGENTPROBE_OPENROUTER_RETRY_BASE_MS,
      DEFAULT_RETRY_BASE_MS,
    );
    this.retryMaxMs = readPositiveInt(
      Bun.env.AGENTPROBE_OPENROUTER_RETRY_MAX_MS,
      DEFAULT_RETRY_MAX_MS,
    );
  }

  assertConfigured(): void {
    if (this.fakeRules.length > 0) {
      return;
    }
    if (!this.apiKey) {
      throw new AgentProbeConfigError(
        "OPEN_ROUTER_API_KEY is required for `agentprobe run`.",
      );
    }
  }

  async create(
    request: OpenAiResponsesRequest,
  ): Promise<OpenAiResponsesResponse> {
    if (this.fakeRules.length > 0) {
      const rule = matchFakeRule(request, this.fakeRules);
      appendFakeLog(this.fakeLogPath, {
        kind: request.text.format.name,
        matched_rule: rule.name ?? "",
        model: request.model || null,
        input: flattenInputText(request),
        request: normalizeJson(request),
      });
      const output =
        typeof rule.output === "string"
          ? rule.output
          : JSON.stringify(normalizeJson(rule.output));
      return { outputText: output, raw: normalizeJson(rule.output) };
    }

    if (!this.apiKey) {
      throw new AgentProbeConfigError(
        "OPEN_ROUTER_API_KEY is required for `agentprobe run`.",
      );
    }

    const body = JSON.stringify({
      model: request.model,
      instructions: request.instructions,
      input: serializeInput(request),
      text: {
        format: {
          type: request.text.format.type,
          name: request.text.format.name,
          description: request.text.format.description,
          schema: request.text.format.schema,
          strict: request.text.format.strict,
        },
      },
      temperature: request.temperature,
      max_output_tokens: request.maxOutputTokens,
      prompt_cache_key: request.promptCacheKey,
      cache_control: request.cacheControl
        ? {
            type: request.cacheControl.type,
            ttl: request.cacheControl.ttl,
          }
        : undefined,
    });

    let lastError: OpenAiResponsesApiError | undefined;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      let response: Response;
      try {
        response = await fetch(`${this.baseUrl}/responses`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body,
        });
      } catch (error) {
        lastError = new OpenAiResponsesApiError(
          `OpenRouter request failed before a response was received (attempt ${attempt}/${this.maxAttempts}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        if (attempt < this.maxAttempts) {
          await sleep(
            computeBackoffMs(attempt, this.retryBaseMs, this.retryMaxMs),
          );
          continue;
        }
        throw lastError;
      }

      if (!response.ok) {
        const bodyText = await response.text();
        const message = `OpenRouter request failed (${response.status}): ${bodyText}`;
        if (response.status === 401 || response.status === 403) {
          throw new OpenAiResponsesAuthenticationError(
            message,
            response.status,
            bodyText,
          );
        }
        const apiError = new OpenAiResponsesApiError(
          message,
          response.status,
          bodyText,
        );
        if (isRetryableStatus(response.status) && attempt < this.maxAttempts) {
          lastError = apiError;
          await sleep(
            retryAfterMs(response) ??
              computeBackoffMs(attempt, this.retryBaseMs, this.retryMaxMs),
          );
          continue;
        }
        throw apiError;
      }

      let payload: Record<string, unknown>;
      try {
        payload = (await response.json()) as Record<string, unknown>;
      } catch (error) {
        throw new OpenAiResponsesApiError(
          `OpenRouter response was not valid JSON: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      const outputText =
        typeof payload.output_text === "string"
          ? payload.output_text
          : extractOutputText(payload);
      if (!outputText.trim()) {
        throw new AgentProbeRuntimeError(
          "OpenAI response contained no text output.",
        );
      }

      return { outputText, raw: normalizeJson(payload) };
    }

    throw (
      lastError ??
      new OpenAiResponsesApiError(
        "OpenRouter request exhausted retries without a response.",
      )
    );
  }
}

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (!header) {
    return undefined;
  }
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(60_000, Math.floor(seconds * 1000));
  }
  const date = Date.parse(header);
  if (Number.isFinite(date)) {
    const delta = date - Date.now();
    return delta > 0 ? Math.min(60_000, delta) : 0;
  }
  return undefined;
}

function extractOutputText(payload: Record<string, unknown>): string {
  const output = payload.output;
  if (!Array.isArray(output)) {
    return "";
  }

  const chunks: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const part of content) {
      if (!part || typeof part !== "object") {
        continue;
      }
      const text = (part as Record<string, unknown>).text;
      if (typeof text === "string" && text.trim()) {
        chunks.push(text.trim());
      }
    }
  }

  return chunks.join("\n").trim();
}

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

import type {
  JsonValue,
  OpenAiResponsesRequest,
  OpenAiResponsesResponse,
} from "../../shared/types/contracts.ts";
import { AgentProbeConfigError, AgentProbeRuntimeError } from "../../shared/utils/errors.ts";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

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

function appendFakeLog(path: string | undefined, record: Record<string, JsonValue>): void {
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

function matchFakeRule(
  request: OpenAiResponsesRequest,
  rules: FakeRule[],
): FakeRule {
  const kind = request.text.format.name;
  for (const rule of rules) {
    if ((rule.kind ?? "") !== kind) {
      continue;
    }
    const inputContains = Array.isArray(rule.inputContains)
      ? rule.inputContains
      : [];
    if (inputContains.some((item) => !request.input.includes(String(item)))) {
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
    `No fake OpenAI response matched the request. kind='${kind}' input='${request.input}'`,
  );
}

export class OpenAiResponsesClient {
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly fakeScriptPath?: string;
  private readonly fakeLogPath?: string;
  private readonly fakeRules: FakeRule[];

  constructor() {
    this.apiKey = Bun.env.OPEN_ROUTER_API_KEY?.trim();
    this.baseUrl = OPENROUTER_BASE_URL;
    this.fakeScriptPath = Bun.env.AGENTPROBE_E2E_OPENAI_SCRIPT?.trim();
    this.fakeLogPath = Bun.env.AGENTPROBE_E2E_OPENAI_LOG?.trim();
    this.fakeRules = loadFakeRules(this.fakeScriptPath);
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

  async create(request: OpenAiResponsesRequest): Promise<OpenAiResponsesResponse> {
    if (this.fakeRules.length > 0) {
      const rule = matchFakeRule(request, this.fakeRules);
      appendFakeLog(this.fakeLogPath, {
        kind: request.text.format.name,
        matched_rule: rule.name ?? "",
        model: request.model || null,
        input: request.input,
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

    const response = await fetch(`${this.baseUrl}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: request.model,
        instructions: request.instructions,
        input: request.input,
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
      }),
    });

    if (!response.ok) {
      throw new AgentProbeRuntimeError(
        `OpenRouter request failed (${response.status}): ${await response.text()}`,
      );
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const outputText =
      typeof payload.output_text === "string"
        ? payload.output_text
        : extractOutputText(payload);
    if (!outputText.trim()) {
      throw new AgentProbeRuntimeError("OpenAI response contained no text output.");
    }

    return { outputText, raw: normalizeJson(payload) };
  }
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

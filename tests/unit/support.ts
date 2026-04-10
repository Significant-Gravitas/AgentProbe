import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type {
  AdapterReply,
  ConversationTurn,
  Endpoints,
  OpenAiResponsesRequest,
  OpenAiResponsesResponse,
  Persona,
  PersonaStep,
  Rubric,
  RubricScore,
  Scenario,
  ScenarioDefaults,
  ToolCallRecord,
} from "../../src/shared/types/contracts.ts";
import { AgentProbeRuntimeError } from "../../src/shared/utils/errors.ts";

export const PROJECT_ROOT = resolve(import.meta.dir, "..", "..");
export const DATA_DIR = join(PROJECT_ROOT, "data");

export class FakeResponsesClient {
  readonly calls: OpenAiResponsesRequest[] = [];

  constructor(
    private readonly responses: Array<
      | OpenAiResponsesResponse
      | Record<string, unknown>
      | string
      | null
      | undefined
    >,
  ) {}

  async create(
    request: OpenAiResponsesRequest,
  ): Promise<OpenAiResponsesResponse> {
    this.calls.push(request);
    if (this.responses.length === 0) {
      throw new Error("No fake OpenAI responses remaining.");
    }

    const payload = this.responses.shift();
    if (payload === null || payload === undefined) {
      return { outputText: "" };
    }
    if (typeof payload === "string") {
      return { outputText: payload };
    }
    if ("outputText" in payload && typeof payload.outputText === "string") {
      return payload as OpenAiResponsesResponse;
    }
    return {
      outputText: JSON.stringify(normalizeApiPayload(payload)),
      raw: payload as OpenAiResponsesResponse["raw"],
    };
  }
}

function camelToSnake(value: string): string {
  if (value === "passed") {
    return "pass";
  }
  return value.replaceAll(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function normalizeApiPayload(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeApiPayload(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      camelToSnake(key),
      normalizeApiPayload(item),
    ]),
  );
}

export class FakeAdapter {
  readonly healthCalls: Array<Record<string, unknown>> = [];
  readonly openCalls: Array<Record<string, unknown>> = [];
  readonly sendCalls: Array<Record<string, unknown>> = [];
  readonly closeCalls: Array<Record<string, unknown>> = [];

  constructor(
    private readonly replies: AdapterReply[],
    private readonly sessionState: Record<string, unknown> = {},
  ) {}

  async healthCheck(renderContext: Record<string, unknown>): Promise<void> {
    this.healthCalls.push({ ...renderContext });
  }

  async openScenario(
    renderContext: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    this.openCalls.push({ ...renderContext });
    return { ...this.sessionState };
  }

  async sendUserTurn(
    renderContext: Record<string, unknown>,
  ): Promise<AdapterReply> {
    this.sendCalls.push({ ...renderContext });
    const next = this.replies.shift();
    if (!next) {
      throw new Error("No fake replies remaining.");
    }
    return next;
  }

  async closeScenario(renderContext: Record<string, unknown>): Promise<void> {
    this.closeCalls.push({ ...renderContext });
  }
}

export class FailingAdapter extends FakeAdapter {
  constructor(private readonly message: string) {
    super([]);
  }

  override async healthCheck(): Promise<void> {
    throw new AgentProbeRuntimeError(this.message);
  }
}

export function buildPersona(overrides: Partial<Persona> = {}): Persona {
  return {
    id: "business-traveler",
    name: "Business Traveler",
    description: "Direct and detail-oriented user.",
    demographics: {
      role: "business customer",
      techLiteracy: "high",
      domainExpertise: "intermediate",
      languageStyle: "terse",
    },
    personality: {
      patience: 2,
      assertiveness: 4,
      detailOrientation: 5,
      cooperativeness: 4,
      emotionalIntensity: 2,
    },
    behavior: {
      openingStyle: "Be direct.",
      followUpStyle: "Answer follow-up questions directly.",
      escalationTriggers: [],
      topicDrift: "none",
      clarificationCompliance: "high",
    },
    systemPrompt: "You are a direct business traveler.",
    ...overrides,
  };
}

export function buildRubric(overrides: Partial<Rubric> = {}): Rubric {
  return {
    id: "customer-support",
    name: "Customer Support",
    passThreshold: 0.7,
    metaPrompt: "Judge behavior: {{ expectations.expected_behavior }}",
    judge: {
      provider: "openai",
      model: "anthropic/claude-opus-4.6",
      temperature: 0,
      maxTokens: 500,
    },
    dimensions: [
      {
        id: "task_completion",
        name: "Task Completion",
        weight: 1,
        scale: {
          type: "likert",
          points: 5,
          labels: {
            "1": "bad",
            "5": "good",
          },
        },
        judgePrompt: "Booking reference: {{ booking_id }}",
      },
    ],
    ...overrides,
  };
}

export function buildScore(
  options: { dimensionId?: string; score?: number; passed?: boolean } = {},
): RubricScore {
  const score = options.score ?? 4;
  return {
    dimensions: {
      [options.dimensionId ?? "task_completion"]: {
        reasoning: "The agent completed the request.",
        evidence: ["The transcript shows a direct answer."],
        score,
      },
    },
    overallNotes: "Solid answer.",
    passed: options.passed ?? score / 5 >= 0.7,
  };
}

export function buildPersonaStep(
  status: PersonaStep["status"],
  message: string | null = null,
): PersonaStep {
  return { status, message };
}

export function buildScenario(
  options: {
    turns?: Scenario["turns"];
    sessions?: Scenario["sessions"];
    context?: Scenario["context"];
    expectations?: Partial<Scenario["expectations"]>;
    maxTurns?: number;
    id?: string;
    name?: string;
    tags?: string[];
  } = {},
): Scenario {
  return {
    id: options.id ?? "flight-rebooking",
    name: options.name ?? "Flight Rebooking",
    tags: options.tags ?? [],
    persona: "business-traveler",
    rubric: "customer-support",
    maxTurns: options.maxTurns,
    context: options.context ?? {
      systemPrompt: "You are a travel assistant.",
      injectedData: { booking_id: "FLT-29481" },
    },
    turns: options.turns ?? [],
    sessions: options.sessions ?? [],
    expectations: {
      mustInclude: [],
      mustNotInclude: [],
      expectedTools: [],
      failureModes: [],
      expectedBehavior: "Agent must help the user quickly.",
      expectedOutcome: "resolved",
      ...options.expectations,
    },
  };
}

export function buildScenarioDefaults(
  overrides: Partial<ScenarioDefaults> = {},
): ScenarioDefaults {
  return {
    maxTurns: 2,
    ...overrides,
  };
}

export function adapterReply(
  assistantText: string,
  options: Partial<AdapterReply> = {},
): AdapterReply {
  return {
    assistantText,
    toolCalls: options.toolCalls ?? [],
    rawExchange: options.rawExchange ?? {},
    latencyMs: options.latencyMs ?? 0,
    usage: options.usage ?? {},
  };
}

export function toolCall(
  name: string,
  args: ToolCallRecord["args"],
  overrides: Partial<ToolCallRecord> = {},
): ToolCallRecord {
  return {
    name,
    args,
    ...overrides,
  };
}

export function sendMessages(adapter: FakeAdapter): string[] {
  return adapter.sendCalls.map((call) => {
    const lastMessage = call.last_message as ConversationTurn | undefined;
    return lastMessage?.content ?? "";
  });
}

export function asResponsesClient(client: FakeResponsesClient) {
  return client as unknown as {
    create: (
      request: OpenAiResponsesRequest,
    ) => Promise<OpenAiResponsesResponse>;
  };
}

export function asEndpoint(endpoint: Endpoints): Endpoints {
  return endpoint;
}

export function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `agentprobe-${prefix}-`));
}

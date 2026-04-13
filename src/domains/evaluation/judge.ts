import {
  OpenAiResponsesApiError,
  OpenAiResponsesAuthenticationError,
} from "../../providers/sdk/openai-responses.ts";
import type { OpenAiResponsesClient } from "../../providers/sdk/openai-responses.ts";
import type {
  JsonValue,
  OpenAiResponsesRequest,
  Rubric,
  RubricScore,
} from "../../shared/types/contracts.ts";
import { AgentProbeRuntimeError } from "../../shared/utils/errors.ts";

const DEFAULT_RETRY_DELAY_MS = 2000;
const MAX_JUDGE_ATTEMPTS = 3;

function judgeRetryDelayMs(): number {
  const raw = Bun.env.AGENTPROBE_JUDGE_RETRY_DELAY_MS?.trim();
  if (!raw) {
    return DEFAULT_RETRY_DELAY_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_RETRY_DELAY_MS;
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function rubricToPromptMarkdown(rubric: Rubric): string {
  const lines = [
    `# Rubric: ${rubric.name}`,
    `- ID: \`${rubric.id}\``,
    `- Pass threshold: ${rubric.passThreshold.toFixed(2)}`,
  ];

  if (rubric.description) {
    lines.push(`- Description: ${rubric.description}`);
  }

  lines.push("", "## Dimensions");
  for (const dimension of rubric.dimensions) {
    lines.push(
      `### ${dimension.name}`,
      `- ID: \`${dimension.id}\``,
      `- Weight: ${dimension.weight.toFixed(2)}`,
      `- Scale type: ${dimension.scale.type}`,
    );
    if (dimension.scale.points !== undefined) {
      lines.push(`- Scale points: ${dimension.scale.points}`);
    }
    lines.push("- Scale labels:");
    for (const [score, label] of Object.entries(dimension.scale.labels)) {
      lines.push(`  - \`${score}\`: ${label}`);
    }
    lines.push("", "#### Judge Prompt", dimension.judgePrompt.trim(), "");
  }

  lines.push("## Scoring Overrides");
  const autoFail = rubric.scoringOverrides?.autoFailConditions ?? [];
  if (autoFail.length > 0) {
    lines.push("### Auto-Fail Conditions");
    for (const condition of autoFail) {
      lines.push(
        `- \`${condition.dimension}\`: ${
          condition.below !== undefined
            ? `below ${condition.below}`
            : `above ${condition.above}`
        }`,
      );
    }
  } else {
    lines.push("- Auto-fail conditions: none");
  }

  const autoPass = rubric.scoringOverrides?.autoPassConditions ?? [];
  if (autoPass.length > 0) {
    lines.push("", "### Auto-Pass Conditions");
    for (const condition of autoPass) {
      lines.push(
        `- \`${condition.dimension}\`: ${
          condition.below !== undefined
            ? `below ${condition.below}`
            : `above ${condition.above}`
        }`,
      );
    }
  } else {
    lines.push("- Auto-pass conditions: none");
  }

  lines.push("", "## Meta Prompt", rubric.metaPrompt.trim());
  return lines.join("\n");
}

function judgeJsonSchema(rubric: Rubric): Record<string, unknown> {
  const dimensionScoreSchema = {
    type: "object",
    properties: {
      reasoning: {
        type: "string",
        description: "Concise reasoning for the assigned score.",
      },
      evidence: {
        type: "array",
        items: { type: "string" },
        description:
          "Short evidence snippets or observations from the transcript.",
      },
      score: {
        type: "number",
        description: "Numeric score for the rubric dimension.",
      },
    },
    required: ["reasoning", "evidence", "score"],
    additionalProperties: false,
  };

  return {
    type: "object",
    properties: {
      dimensions: {
        type: "object",
        properties: Object.fromEntries(
          rubric.dimensions.map((dimension) => [
            dimension.id,
            {
              ...dimensionScoreSchema,
              description: `Score details for rubric dimension \`${dimension.id}\`.`,
            },
          ]),
        ),
        required: rubric.dimensions.map((dimension) => dimension.id),
        additionalProperties: false,
      },
      overall_notes: {
        type: "string",
        description: "Short overall summary of strengths and failures.",
      },
      pass: {
        type: "boolean",
        description: "Whether the evaluated response passes the rubric.",
      },
      failure_mode_detected: {
        type: ["string", "null"],
        description:
          "Named failure mode detected in the response, or null when none apply.",
      },
    },
    required: ["dimensions", "overall_notes", "pass", "failure_mode_detected"],
    additionalProperties: false,
  };
}

function judgeInstructions(
  rubric: Rubric,
  schema: Record<string, unknown>,
): string {
  const dimensionIds = rubric.dimensions
    .map((item) => item.id)
    .sort()
    .join(", ");
  return [
    "You are an expert rubric judge. Evaluate only the provided response.",
    "",
    rubricToPromptMarkdown(rubric),
    "",
    "Return structured output matching the requested schema exactly.",
    `The \`dimensions\` object must contain exactly these rubric dimension ids: ${dimensionIds}.`,
    "If the scenario defines failure modes, set `failure_mode_detected` to the matching named failure mode or null when none apply.",
    "",
    "JSON schema:",
    JSON.stringify(schema, null, 2),
  ].join("\n");
}

function parseRubricScore(payload: string): RubricScore {
  const parsed = JSON.parse(payload) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AgentProbeRuntimeError("Judge returned invalid JSON output.");
  }

  const record = parsed as Record<string, unknown>;
  const dimensionsRaw = record.dimensions;
  if (
    !dimensionsRaw ||
    typeof dimensionsRaw !== "object" ||
    Array.isArray(dimensionsRaw)
  ) {
    throw new AgentProbeRuntimeError("Judge returned invalid JSON output.");
  }

  return {
    dimensions: Object.fromEntries(
      Object.entries(dimensionsRaw as Record<string, unknown>).map(
        ([key, value]) => {
          const item = value as Record<string, unknown>;
          return [
            key,
            {
              reasoning:
                typeof item.reasoning === "string" ? item.reasoning : "",
              evidence: Array.isArray(item.evidence)
                ? item.evidence.flatMap((entry) =>
                    typeof entry === "string" ? [entry] : [],
                  )
                : [],
              score:
                typeof item.score === "number"
                  ? item.score
                  : typeof item.score === "string"
                    ? Number(item.score)
                    : 0,
            },
          ];
        },
      ),
    ),
    overallNotes:
      typeof record.overall_notes === "string" ? record.overall_notes : "",
    passed: record.pass === true,
    failureModeDetected:
      typeof record.failure_mode_detected === "string"
        ? record.failure_mode_detected
        : record.failure_mode_detected === null
          ? null
          : undefined,
  };
}

function validateRubricScore(rubric: Rubric, score: RubricScore): void {
  const expected = new Set(rubric.dimensions.map((dimension) => dimension.id));
  const actual = new Set(Object.keys(score.dimensions));
  const missing = [...expected].filter((id) => !actual.has(id));
  const extra = [...actual].filter((id) => !expected.has(id));
  if (missing.length > 0 || extra.length > 0) {
    const parts: string[] = [];
    if (missing.length > 0) {
      parts.push(`missing dimensions: ${missing.join(", ")}`);
    }
    if (extra.length > 0) {
      parts.push(`unexpected dimensions: ${extra.join(", ")}`);
    }
    throw new AgentProbeRuntimeError(
      `Judge output did not match rubric dimensions: ${parts.join("; ")}`,
    );
  }
}

export async function judgeResponse(
  rubric: Rubric,
  responseText: string,
  client: OpenAiResponsesClient,
): Promise<RubricScore> {
  if (rubric.dimensions.length === 0) {
    throw new AgentProbeRuntimeError(
      "Cannot judge a rubric with no dimensions.",
    );
  }
  if (!rubric.judge) {
    throw new AgentProbeRuntimeError("Rubric is missing judge configuration.");
  }
  if (rubric.judge.provider !== "openai") {
    throw new AgentProbeRuntimeError(
      `judge.ts only supports OpenAI judges, got: ${rubric.judge.provider}`,
    );
  }

  const schema = judgeJsonSchema(rubric);
  const request: OpenAiResponsesRequest = {
    model: rubric.judge.model,
    instructions: judgeInstructions(rubric, schema),
    input: `Response to evaluate:\n\n${responseText}`,
    text: {
      format: {
        type: "json_schema",
        name: "rubric_score",
        description: "Structured rubric evaluation for an agent response.",
        schema: schema as Record<string, JsonValue>,
        strict: true,
      },
    },
    temperature: rubric.judge.temperature,
    maxOutputTokens: rubric.judge.maxTokens,
  };

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_JUDGE_ATTEMPTS; attempt += 1) {
    try {
      const response = await client.create(request);
      if (!response.outputText.trim()) {
        throw new AgentProbeRuntimeError(
          "Judge response contained no text output.",
        );
      }
      const score = parseRubricScore(response.outputText);
      validateRubricScore(rubric, score);
      return score;
    } catch (error) {
      lastError = error;
      if (error instanceof OpenAiResponsesAuthenticationError) {
        throw new AgentProbeRuntimeError(
          `Judge authentication failed for model '${rubric.judge.model}'. Set a valid OPEN_ROUTER_API_KEY before running agentprobe.`,
        );
      }

      if (error instanceof OpenAiResponsesApiError) {
        const statusCode = error.statusCode;
        if (statusCode && statusCode >= 400 && statusCode < 500 && statusCode !== 429) {
          throw error;
        }
        if (attempt < MAX_JUDGE_ATTEMPTS) {
          await sleep(judgeRetryDelayMs());
          continue;
        }
        break;
      }

      if (
        error instanceof SyntaxError ||
        (error instanceof AgentProbeRuntimeError &&
          /invalid JSON output|no text output|did not match rubric dimensions/i.test(
            error.message,
          ))
      ) {
        if (attempt < MAX_JUDGE_ATTEMPTS) {
          continue;
        }
        break;
      }

      throw error;
    }
  }

  throw (
    lastError instanceof Error
      ? lastError
      : new AgentProbeRuntimeError(String(lastError))
  );
}

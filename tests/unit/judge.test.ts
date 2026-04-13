import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { judgeResponse } from "../../src/domains/evaluation/judge.ts";
import { parseRubricsYaml } from "../../src/domains/validation/load-suite.ts";
import {
  OpenAiResponsesApiError,
  OpenAiResponsesAuthenticationError,
} from "../../src/providers/sdk/openai-responses.ts";
import {
  asResponsesClient,
  buildRubric,
  buildScore,
  DATA_DIR,
  FakeResponsesClient,
  makeTempDir,
} from "./support.ts";

describe("judge", () => {
  const originalRetryDelay = process.env.AGENTPROBE_JUDGE_RETRY_DELAY_MS;

  beforeEach(() => {
    process.env.AGENTPROBE_JUDGE_RETRY_DELAY_MS = "0";
  });

  afterEach(() => {
    if (originalRetryDelay === undefined) {
      delete process.env.AGENTPROBE_JUDGE_RETRY_DELAY_MS;
    } else {
      process.env.AGENTPROBE_JUDGE_RETRY_DELAY_MS = originalRetryDelay;
    }
  });

  test("uses structured output requests", async () => {
    const rubric = buildRubric({
      id: "support",
      name: "Support Rubric",
      metaPrompt: "Score the assistant response.",
      dimensions: [
        {
          id: "accuracy",
          name: "Accuracy",
          weight: 1,
          scale: {
            type: "likert",
            points: 5,
            labels: { "1": "bad", "5": "good" },
          },
          judgePrompt: "Check factual accuracy.",
        },
      ],
      judge: {
        provider: "openai",
        model: "anthropic/claude-opus-4.6",
        temperature: 0.15,
        maxTokens: 321,
      },
    });
    const parsed = buildScore({ dimensionId: "accuracy" });
    const client = new FakeResponsesClient([parsed]);

    const result = await judgeResponse(
      rubric,
      "Reset your password from settings.",
      asResponsesClient(client) as never,
    );

    expect(result).toEqual(parsed);
    expect(client.calls).toHaveLength(1);
    const call = client.calls[0];
    expect(call).toBeDefined();
    expect(rubric.judge).toBeDefined();
    if (!call || !rubric.judge) {
      throw new Error("Expected judge call configuration to be present.");
    }
    expect(call.model).toBe(rubric.judge.model);
    expect(call.text.format.type).toBe("json_schema");
    expect(call.text.format.strict).toBe(true);
    expect(call.text.format.schema.additionalProperties).toBe(false);
    expect(call.temperature).toBe(rubric.judge.temperature);
    expect(call.maxOutputTokens).toBe(rubric.judge.maxTokens);
    expect(call.input).toBe(
      "Response to evaluate:\n\nReset your password from settings.",
    );
    expect(call.instructions).toContain("accuracy");
    expect(call.instructions).toContain('"additionalProperties": false');
  });

  test("rejects missing judge config, wrong provider, dimension mismatches, and empty rubrics", async () => {
    const baseClient = asResponsesClient(
      new FakeResponsesClient([buildScore({ dimensionId: "accuracy" })]),
    ) as never;

    await expect(
      judgeResponse(
        buildRubric({ judge: undefined }),
        "Test response",
        baseClient,
      ),
    ).rejects.toThrow(/missing judge configuration/i);

    await expect(
      judgeResponse(
        buildRubric({
          judge: {
            provider: "anthropic",
            model: "claude-sonnet-4-20250514",
            temperature: 0,
            maxTokens: 4096,
          },
        }),
        "Test response",
        baseClient,
      ),
    ).rejects.toThrow(/only supports OpenAI/i);

    await expect(
      judgeResponse(
        buildRubric(),
        "Test response",
        asResponsesClient(
          new FakeResponsesClient([
            buildScore({ dimensionId: "relevance" }),
            buildScore({ dimensionId: "relevance" }),
            buildScore({ dimensionId: "relevance" }),
          ]),
        ) as never,
      ),
    ).rejects.toThrow(/missing dimensions: task_completion/i);

    await expect(
      judgeResponse(
        buildRubric({ dimensions: [] }),
        "Test response",
        baseClient,
      ),
    ).rejects.toThrow(/no dimensions/i);
  });

  test("retries invalid JSON-style judge outputs and parses failure_mode_detected", async () => {
    const client = new FakeResponsesClient([
      "not valid json",
      buildScore({
        dimensionId: "task_completion",
        failureModeDetected: "fabrication",
      }),
    ]);

    const result = await judgeResponse(
      buildRubric(),
      "Test response",
      asResponsesClient(client) as never,
    );

    expect(client.calls).toHaveLength(2);
    expect(result.failureModeDetected).toBe("fabrication");
  });

  test("retries retryable API errors and eventually succeeds", async () => {
    const successClient = new FakeResponsesClient([
      buildScore({ dimensionId: "task_completion" }),
    ]);
    let attempts = 0;
    const client = {
      async create(request: Parameters<FakeResponsesClient["create"]>[0]) {
        attempts += 1;
        if (attempts < 3) {
          throw new OpenAiResponsesApiError("rate limited", 429, "{}");
        }
        return await successClient.create(request);
      },
    };

    const result = await judgeResponse(
      buildRubric(),
      "Test response",
      client as never,
    );

    expect(attempts).toBe(3);
    expect(result.passed).toBe(true);
  });

  test("does not retry authentication failures or non-429 4xx responses", async () => {
    let authAttempts = 0;
    const authClient = {
      async create() {
        authAttempts += 1;
        throw new OpenAiResponsesAuthenticationError("unauthorized", 401, "{}");
      },
    };

    await expect(
      judgeResponse(buildRubric(), "Test response", authClient as never),
    ).rejects.toThrow(/Judge authentication failed/i);
    expect(authAttempts).toBe(1);

    let badRequestAttempts = 0;
    const badRequestClient = {
      async create() {
        badRequestAttempts += 1;
        throw new OpenAiResponsesApiError("bad request", 400, "{}");
      },
    };

    await expect(
      judgeResponse(buildRubric(), "Test response", badRequestClient as never),
    ).rejects.toThrow(/bad request/i);
    expect(badRequestAttempts).toBe(1);
  });

  test("fails after exhausting retries on invalid judge output", async () => {
    const client = new FakeResponsesClient([
      "still not json",
      "still not json",
      "still not json",
    ]);

    await expect(
      judgeResponse(
        buildRubric(),
        "Test response",
        asResponsesClient(client) as never,
      ),
    ).rejects.toThrow();
    expect(client.calls).toHaveLength(3);
  });

  test("applies top-level judge config while parsing rubric yaml", () => {
    const path = join(makeTempDir("rubric-parse"), "rubric.yaml");
    writeFileSync(
      path,
      [
        'version: "1.0"',
        "judge:",
        "  provider: openai",
        "  model: anthropic/claude-opus-4.6",
        "  temperature: 0.25",
        "  max_tokens: 777",
        "rubrics:",
        "  - id: support",
        "    name: Support",
        "    pass_threshold: 0.7",
        "    meta_prompt: Score it.",
        "    dimensions:",
        "      - id: accuracy",
        "        name: Accuracy",
        "        weight: 1.0",
        "        scale:",
        "          type: likert",
        "          points: 5",
        "          labels:",
        '            1: "bad"',
        '            5: "good"',
        "        judge_prompt: Check accuracy.",
        "",
      ].join("\n"),
      "utf8",
    );

    const parsed = parseRubricsYaml(path);

    expect(parsed.metadata.judge?.model).toBe("anthropic/claude-opus-4.6");
    expect(parsed.rubrics[0]?.judge?.model).toBe("anthropic/claude-opus-4.6");
    expect(parsed.rubrics[0]?.judge?.temperature).toBe(0.25);

    unlinkSync(path);
  });

  test("parses alias-based rubrics from the repo data file", () => {
    const parsed = parseRubricsYaml(join(DATA_DIR, "rubric.yaml"));
    const inherited = parsed.rubrics.find(
      (rubric) => rubric.id === "sales-automation",
    );
    const rubricIds = new Set(parsed.rubrics.map((rubric) => rubric.id));

    expect(parsed.rubrics).toHaveLength(21);
    expect(inherited?.metaPrompt).toContain("task-oriented scenario");
    expect(inherited?.dimensions).toHaveLength(5);
    expect(inherited?.judge?.model).toBe("anthropic/claude-opus-4.6");
    for (const rubricId of [
      "memory-temporal",
      "memory-abstention",
      "memory-crossdomain",
      "memory-compositional",
      "memory-introspection",
      "memory-hygiene",
    ]) {
      expect(rubricIds.has(rubricId)).toBe(true);
    }
  });
});

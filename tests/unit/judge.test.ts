import { describe, expect, test } from "bun:test";
import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { judgeResponse } from "../../src/domains/evaluation/judge.ts";
import { parseRubricsYaml } from "../../src/domains/validation/load-suite.ts";
import {
  asResponsesClient,
  buildRubric,
  buildScore,
  DATA_DIR,
  FakeResponsesClient,
  makeTempDir,
} from "./support.ts";

describe("judge", () => {
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

  test("rejects missing judge config, wrong provider, empty output, dimension mismatches, and empty rubrics", async () => {
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
        asResponsesClient(new FakeResponsesClient([null])) as never,
      ),
    ).rejects.toThrow(/invalid JSON output|contained no text output/i);

    await expect(
      judgeResponse(
        buildRubric(),
        "Test response",
        asResponsesClient(
          new FakeResponsesClient([buildScore({ dimensionId: "relevance" })]),
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

    expect(parsed.rubrics).toHaveLength(15);
    expect(inherited?.metaPrompt).toContain("task-oriented scenario");
    expect(inherited?.dimensions).toHaveLength(5);
    expect(inherited?.judge?.model).toBe("anthropic/claude-opus-4.6");
  });
});

import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  parseScenarioYaml,
  parseTimeOffset,
} from "../../src/domains/validation/load-suite.ts";
import { makeTempDir } from "./support.ts";

describe("scenario parsing", () => {
  test("parseTimeOffset supports hour, day, and minute suffixes", () => {
    expect(parseTimeOffset("6h")).toBe(6 * 60 * 60 * 1000);
    expect(parseTimeOffset("2d")).toBe(2 * 24 * 60 * 60 * 1000);
    expect(parseTimeOffset("15m")).toBe(15 * 60 * 1000);
    expect(parseTimeOffset("nope")).toBe(0);
  });

  test("injects user_name and copilot_mode defaults into scenario context", () => {
    const path = join(makeTempDir("scenario-defaults"), "scenarios.yaml");
    writeFileSync(
      path,
      [
        "defaults:",
        "  persona: shopper",
        "  rubric: support",
        '  user_name: "Jordan Rivera"',
        '  copilot_mode: "fast"',
        "scenarios:",
        "  - id: smoke",
        '    name: "Smoke"',
        "    context:",
        '      system_prompt: "Help the user."',
        "    turns:",
        "      - role: user",
        '        content: "hello"',
        "    expectations:",
        '      expected_behavior: "Help."',
        "      expected_outcome: resolved",
        "",
      ].join("\n"),
      "utf8",
    );

    const parsed = parseScenarioYaml(path);
    const scenario = parsed.scenarios[0];

    expect(scenario?.context?.userName).toBe("Jordan Rivera");
    expect(scenario?.context?.copilotMode).toBe("fast");
  });

  test("parses a retrieval block with defaults", () => {
    const path = join(makeTempDir("scenario-retrieval-basic"), "scenarios.yaml");
    writeFileSync(
      path,
      [
        "defaults:",
        "  persona: shopper",
        "  rubric: support",
        "scenarios:",
        "  - id: retrieval-basic",
        '    name: "Retrieval basic"',
        "    turns:",
        "      - role: user",
        '        content: "what do we have on Sarah?"',
        "    expectations:",
        '      expected_behavior: "Surface gold items."',
        "      expected_outcome: resolved",
        "    retrieval:",
        "      golden:",
        '        - "Sarah\\u0027s email"',
        '        - "Atlas project status"',
        "      k: 5",
        "",
      ].join("\n"),
      "utf8",
    );

    const parsed = parseScenarioYaml(path);
    const scenario = parsed.scenarios[0];

    expect(scenario?.retrieval).toBeDefined();
    expect(scenario?.retrieval?.golden).toEqual([
      "Sarah's email",
      "Atlas project status",
    ]);
    expect(scenario?.retrieval?.k).toBe(5);
    expect(scenario?.retrieval?.weights.precision_at_k).toBe(1);
    expect(scenario?.retrieval?.weights.recall_at_k).toBe(1);
    expect(scenario?.retrieval?.weights.mrr).toBe(1);
    expect(scenario?.retrieval?.weights.ndcg_at_k).toBe(1);
    expect(scenario?.retrieval?.passThreshold).toBe(0.5);
    expect(scenario?.retrieval?.match).toBe("substring");
  });

  test("parses retrieval block with custom weights, forbidden, threshold, and source", () => {
    const path = join(
      makeTempDir("scenario-retrieval-custom"),
      "scenarios.yaml",
    );
    writeFileSync(
      path,
      [
        "defaults:",
        "  persona: shopper",
        "  rubric: support",
        "scenarios:",
        "  - id: retrieval-custom",
        '    name: "Retrieval custom"',
        "    turns:",
        "      - role: user",
        '        content: "what is our Q2 budget?"',
        "    expectations:",
        '      expected_behavior: "Honor forget request."',
        "      expected_outcome: resolved",
        "    retrieval:",
        "      golden:",
        '        - "I do not have that"',
        "      forbidden:",
        '        - "$50K"',
        "      k: 3",
        "      pass_threshold: 0.6",
        "      match: substring",
        "      weight:",
        "        precision_at_k: 0.5",
        "        recall_at_k: 2.0",
        "        mrr: 1.0",
        "        ndcg_at_k: 1.5",
        "      source:",
        '        raw_exchange_key: "memories"',
        "",
      ].join("\n"),
      "utf8",
    );

    const parsed = parseScenarioYaml(path);
    const scenario = parsed.scenarios[0];

    expect(scenario?.retrieval?.forbidden).toEqual(["$50K"]);
    expect(scenario?.retrieval?.k).toBe(3);
    expect(scenario?.retrieval?.passThreshold).toBeCloseTo(0.6, 6);
    expect(scenario?.retrieval?.weights.recall_at_k).toBe(2);
    expect(scenario?.retrieval?.weights.precision_at_k).toBe(0.5);
    expect(scenario?.retrieval?.source?.rawExchangeKey).toBe("memories");
  });

  test("rejects retrieval config with empty golden", () => {
    const path = join(
      makeTempDir("scenario-retrieval-empty-golden"),
      "scenarios.yaml",
    );
    writeFileSync(
      path,
      [
        "defaults:",
        "  persona: shopper",
        "  rubric: support",
        "scenarios:",
        "  - id: retrieval-empty",
        '    name: "Retrieval empty"',
        "    turns:",
        "      - role: user",
        '        content: "x"',
        "    expectations:",
        '      expected_behavior: "x"',
        "      expected_outcome: resolved",
        "    retrieval:",
        "      golden: []",
        "",
      ].join("\n"),
      "utf8",
    );

    expect(() => parseScenarioYaml(path)).toThrow(
      /retrieval.golden must be a non-empty/,
    );
  });

  test("rejects unknown retrieval metric weight keys", () => {
    const path = join(
      makeTempDir("scenario-retrieval-bad-weight"),
      "scenarios.yaml",
    );
    writeFileSync(
      path,
      [
        "defaults:",
        "  persona: shopper",
        "  rubric: support",
        "scenarios:",
        "  - id: retrieval-bad-weight",
        '    name: "Retrieval bad weight"',
        "    turns:",
        "      - role: user",
        '        content: "x"',
        "    expectations:",
        '      expected_behavior: "x"',
        "      expected_outcome: resolved",
        "    retrieval:",
        "      golden:",
        '        - "foo"',
        "      weight:",
        "        hit_rate: 1.0",
        "",
      ].join("\n"),
      "utf8",
    );

    expect(() => parseScenarioYaml(path)).toThrow(
      /Unknown retrieval metric key/,
    );
  });

  test("parses session max_turns and scenario base_date", () => {
    const path = join(makeTempDir("scenario-sessions"), "scenarios.yaml");
    writeFileSync(
      path,
      [
        "defaults:",
        "  persona: shopper",
        "  rubric: support",
        "scenarios:",
        "  - id: memory",
        '    name: "Memory"',
        '    base_date: "2026-04-01"',
        "    sessions:",
        '      - id: "seed"',
        '        time_offset: "48h"',
        "        reset: fresh_agent",
        "        max_turns: 2",
        "        turns:",
        "          - role: user",
        '            content: "remember this"',
        "            use_exact_message: true",
        "    expectations:",
        '      expected_behavior: "Remember it."',
        "      expected_outcome: resolved",
        "",
      ].join("\n"),
      "utf8",
    );

    const parsed = parseScenarioYaml(path);
    const scenario = parsed.scenarios[0];
    const session = scenario?.sessions[0];

    expect(scenario?.baseDate).toBe("2026-04-01");
    expect(session?.timeOffset).toBe("48h");
    expect(session?.maxTurns).toBe(2);
  });
});

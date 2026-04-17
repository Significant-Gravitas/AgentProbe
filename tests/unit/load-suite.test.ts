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

import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { SuiteController } from "../../../src/runtime/server/controllers/suite-controller.ts";
import { makeTempDir } from "../support.ts";

function writeSharedFiles(root: string): void {
  writeFileSync(
    join(root, "personas.yaml"),
    [
      "personas:",
      "  - id: analyst",
      "    name: Analyst",
      "    demographics:",
      "      role: operator",
      "      tech_literacy: high",
      "      domain_expertise: intermediate",
      "      language_style: terse",
      "    personality:",
      "      patience: 3",
      "      assertiveness: 3",
      "      detail_orientation: 4",
      "      cooperativeness: 4",
      "      emotional_intensity: 1",
      "    behavior:",
      "      opening_style: Direct.",
      "      follow_up_style: Concise.",
      "      escalation_triggers: []",
      "      topic_drift: none",
      "      clarification_compliance: high",
      "    system_prompt: You are direct.",
      "",
    ].join("\n"),
    "utf8",
  );
}

function scenarioDoc(name: string): string {
  return [
    "scenarios:",
    "  - id: duplicate",
    `    name: ${name}`,
    "    tags: [smoke]",
    "    persona: analyst",
    "    rubric: support",
    "    turns:",
    "      - role: user",
    "        content: Say hello.",
    "        use_exact_message: true",
    "    expectations:",
    "      expected_behavior: Greets the user.",
    "",
  ].join("\n");
}

describe("server scenario selection", () => {
  test("resolves duplicate scenario ids by file and id", () => {
    const root = makeTempDir("server-selection");
    mkdirSync(root, { recursive: true });
    writeSharedFiles(root);
    writeFileSync(join(root, "a.yaml"), scenarioDoc("Alpha"), "utf8");
    writeFileSync(join(root, "b.yaml"), scenarioDoc("Beta"), "utf8");

    const controller = new SuiteController({ dataPath: root });
    const resolved = controller.resolveSelection([
      { file: "a.yaml", id: "duplicate" },
      { file: "b.yaml", id: "duplicate" },
    ]);

    expect(resolved.refs).toEqual([
      { file: "a.yaml", id: "duplicate" },
      { file: "b.yaml", id: "duplicate" },
    ]);
    expect(resolved.selectedScenarios.map((scenario) => scenario.name)).toEqual(
      ["Alpha", "Beta"],
    );
  });

  test("rejects scenario selection paths outside the data root", () => {
    const root = makeTempDir("server-selection-outside");
    mkdirSync(root, { recursive: true });
    const controller = new SuiteController({ dataPath: root });

    expect(() =>
      controller.resolveSelection([{ file: "../outside.yaml", id: "x" }]),
    ).toThrow(/data root/);
  });
});

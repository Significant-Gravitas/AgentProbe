import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { scoreRetrieval } from "../../src/domains/evaluation/retrieval-scorer.ts";
import {
  parseRubricsYaml,
  parseScenarioYaml,
} from "../../src/domains/validation/load-suite.ts";

const SCENARIOS_PATH = resolve(
  import.meta.dir,
  "..",
  "..",
  "data",
  "retrieval-memory.yaml",
);
const RUBRIC_PATH = resolve(import.meta.dir, "..", "..", "data", "rubric.yaml");

describe("retrieval-memory pack", () => {
  const parsed = parseScenarioYaml(SCENARIOS_PATH);
  const scenarios = parsed.scenarios;

  test("declares at least five ranking-scored scenarios", () => {
    const withRetrieval = scenarios.filter((s) => s.retrieval !== undefined);
    expect(withRetrieval.length).toBeGreaterThanOrEqual(5);
  });

  test("every scenario references a known memory rubric", () => {
    const rubrics = parseRubricsYaml(RUBRIC_PATH);
    const rubricIds = new Set(rubrics.rubrics.map((r) => r.id));
    for (const scenario of scenarios) {
      expect(scenario.rubric).toBeDefined();
      expect(rubricIds.has(scenario.rubric ?? "")).toBe(true);
    }
  });

  test("each retrieval block uses fixture source that exists relative to the YAML", () => {
    for (const scenario of scenarios) {
      const fixture = scenario.retrieval?.source?.fixture;
      expect(fixture).toBeDefined();
      // Resolve relative to YAML dir.
      const resolved = resolve(SCENARIOS_PATH, "..", fixture ?? "");
      // Sanity-check the file exists (Bun.file.exists is sync via existsSync)
      const exists = require("node:fs").existsSync(resolved);
      expect(exists).toBe(true);
    }
  });

  function requireScenario(id: string) {
    const scenario = scenarios.find((s) => s.id === id);
    if (!scenario) {
      throw new Error(`Missing scenario in pack: ${id}`);
    }
    return scenario;
  }

  test("forget-on-request scenario forbids the budget figure and passes against the fixture", () => {
    const scenario = requireScenario("mem-retrieval-forget-on-request");
    expect(scenario.retrieval?.forbidden ?? []).toContain("$50K");

    const score = scoreRetrieval(scenario, {
      scenariosPath: SCENARIOS_PATH,
    });
    expect(score?.forbiddenHits).toBe(0);
  });

  test("warm-context scenario scores its happy-path fixture as passed", () => {
    const scenario = requireScenario("mem-retrieval-warm-context-sarah");

    const score = scoreRetrieval(scenario, {
      scenariosPath: SCENARIOS_PATH,
    });
    expect(score?.source).toBe("fixture");
    expect(score?.passed).toBe(true);
    expect(score?.hitCount).toBeGreaterThanOrEqual(2);
  });

  test("stale-fact demotion scenario passes when only the new pricing surfaces", () => {
    const scenario = requireScenario("mem-retrieval-stale-fact-demotion");

    const score = scoreRetrieval(scenario, {
      scenariosPath: SCENARIOS_PATH,
    });
    // The fixture intentionally still contains the superseded item to prove
    // the forbidden-hit check is active. So this scenario, when run against
    // its committed fixture, should fail. That documents the negative-test
    // intent of the YAML: swap the fixture for an actual retrieval payload,
    // and a correctly-functioning dream pass would have demoted the old
    // pricing out of the top-k.
    expect(score?.source).toBe("fixture");
    expect(score?.forbiddenHits).toBeGreaterThan(0);
    expect(score?.passed).toBe(false);
  });

  test("scope-filter scenario passes against its in-scope-only fixture", () => {
    const scenario = requireScenario("mem-retrieval-scope-filter-project");

    const score = scoreRetrieval(scenario, {
      scenariosPath: SCENARIOS_PATH,
    });
    expect(score?.forbiddenHits).toBe(0);
    expect(score?.passed).toBe(true);
  });

  test("cascading-expiry scenario passes when the entity's facts are gone but adjacent facts remain", () => {
    const scenario = requireScenario("mem-retrieval-cascading-expiry");

    const score = scoreRetrieval(scenario, {
      scenariosPath: SCENARIOS_PATH,
    });
    expect(score?.forbiddenHits).toBe(0);
    expect(score?.passed).toBe(true);
  });
});

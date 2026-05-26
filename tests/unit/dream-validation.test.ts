import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { scoreScenarioDedup } from "../../src/domains/evaluation/dedup-scorer.ts";
import { scoreScenarioDemotion } from "../../src/domains/evaluation/demotion-scorer.ts";
import { scoreScenarioProcedure } from "../../src/domains/evaluation/procedure-scorer.ts";
import { parseScenarioYaml } from "../../src/domains/validation/load-suite.ts";

const SCENARIOS_PATH = resolve(
  import.meta.dir,
  "..",
  "..",
  "data",
  "dream-validation.yaml",
);

describe("dream-validation pack", () => {
  const parsed = parseScenarioYaml(SCENARIOS_PATH);
  const scenarios = parsed.scenarios;

  function requireScenario(id: string) {
    const scenario = scenarios.find((s) => s.id === id);
    if (!scenario) {
      throw new Error(`Missing scenario: ${id}`);
    }
    return scenario;
  }

  test("ships at least four demotion, two procedure, and two dedup scenarios", () => {
    const demotion = scenarios.filter((s) => s.demotion !== undefined);
    const procedure = scenarios.filter((s) => s.procedure !== undefined);
    const dedup = scenarios.filter((s) => s.dedup !== undefined);
    expect(demotion.length).toBeGreaterThanOrEqual(4);
    expect(procedure.length).toBeGreaterThanOrEqual(2);
    expect(dedup.length).toBeGreaterThanOrEqual(2);
  });

  test("every scenario references a fixture that exists on disk", () => {
    for (const scenario of scenarios) {
      const fixture =
        scenario.demotion?.source?.fixture ??
        scenario.procedure?.source?.fixture ??
        scenario.dedup?.source?.fixture;
      expect(fixture).toBeDefined();
      const resolved = resolve(SCENARIOS_PATH, "..", fixture ?? "");
      expect(existsSync(resolved)).toBe(true);
    }
  });

  test("Snodgrass-respecting retract scenario passes", () => {
    const scenario = requireScenario("dream-demotion-retract-discipline");
    const score = scoreScenarioDemotion(scenario, {
      scenariosPath: SCENARIOS_PATH,
    });
    expect(score?.source).toBe("fixture");
    expect(score?.timestampViolationCount).toBe(0);
    expect(score?.passed).toBe(true);
  });

  test("Snodgrass-violating retract scenario fails on timestamp discipline", () => {
    const scenario = requireScenario("dream-demotion-snodgrass-violation");
    const score = scoreScenarioDemotion(scenario, {
      scenariosPath: SCENARIOS_PATH,
    });
    expect(score?.timestampViolationCount).toBeGreaterThan(0);
    expect(score?.passed).toBe(false);
  });

  test("bounded cascade scenario passes (single-hop discipline held)", () => {
    const scenario = requireScenario("dream-demotion-cascade-bounded");
    const score = scoreScenarioDemotion(scenario, {
      scenariosPath: SCENARIOS_PATH,
    });
    expect(score?.cascadeBounded).toBe(true);
    expect(score?.passed).toBe(true);
  });

  test("runaway cascade scenario fails on cascade_bounded", () => {
    const scenario = requireScenario("dream-demotion-cascade-runaway");
    const score = scoreScenarioDemotion(scenario, {
      scenariosPath: SCENARIOS_PATH,
    });
    expect(score?.cascadeBounded).toBe(false);
    expect(score?.passed).toBe(false);
  });

  test("weekly-report procedure scenario passes against its golden", () => {
    const scenario = requireScenario("dream-procedure-weekly-report");
    const score = scoreScenarioProcedure(scenario, {
      scenariosPath: SCENARIOS_PATH,
    });
    expect(score?.source).toBe("fixture");
    expect(score?.passed).toBe(true);
  });

  test("client-onboarding procedure scenario passes against its golden", () => {
    const scenario = requireScenario("dream-procedure-client-onboarding");
    const score = scoreScenarioProcedure(scenario, {
      scenariosPath: SCENARIOS_PATH,
    });
    expect(score?.passed).toBe(true);
  });

  test("clean dedup scenario passes (no over-merge, no under-merge)", () => {
    const scenario = requireScenario("dream-dedup-near-duplicates");
    const score = scoreScenarioDedup(scenario, {
      scenariosPath: SCENARIOS_PATH,
    });
    expect(score?.passed).toBe(true);
  });

  test("over-merge dedup scenario fails on pairwise precision + ARI", () => {
    const scenario = requireScenario("dream-dedup-false-positive");
    const score = scoreScenarioDedup(scenario, {
      scenariosPath: SCENARIOS_PATH,
    });
    expect(score?.passed).toBe(false);
  });
});

import { describe, expect, test } from "bun:test";
import type { ReadableRepository } from "../../../src/providers/persistence/types.ts";
import {
  buildComparisonPayload,
  chooseAlignment,
  createComparisonController,
  MAX_COMPARISON_RUNS,
  MIN_COMPARISON_RUNS,
} from "../../../src/runtime/server/controllers/comparison-controller.ts";
import type {
  RunRecord,
  ScenarioRecord,
} from "../../../src/shared/types/contracts.ts";

function scenario(partial: Partial<ScenarioRecord>): ScenarioRecord {
  return {
    scenarioRunId: 1,
    ordinal: 0,
    scenarioId: "s-1",
    scenarioName: "Scenario One",
    personaId: "p-1",
    rubricId: "r-1",
    userId: null,
    tags: [],
    priority: null,
    expectations: null,
    scenarioSnapshot: null,
    personaSnapshot: null,
    rubricSnapshot: null,
    status: "completed",
    passed: true,
    failureKind: null,
    overallScore: 0.9,
    passThreshold: 0.7,
    judge: {
      provider: null,
      model: null,
      temperature: null,
      maxTokens: null,
      overallNotes: null,
      output: null,
    },
    counts: {
      turnCount: 0,
      assistantTurnCount: 0,
      toolCallCount: 0,
      checkpointCount: 0,
    },
    turns: [],
    targetEvents: [],
    toolCalls: [],
    checkpoints: [],
    judgeDimensionScores: [],
    error: null,
    startedAt: "2026-04-17T12:00:00Z",
    completedAt: "2026-04-17T12:01:00Z",
    ...partial,
  };
}

function run(partial: Partial<RunRecord>): RunRecord {
  const base: RunRecord = {
    runId: "run-a",
    status: "completed",
    passed: true,
    exitCode: 0,
    preset: null,
    label: null,
    trigger: "cli",
    cancelledAt: null,
    presetId: null,
    startedAt: "2026-04-17T12:00:00Z",
    completedAt: "2026-04-17T12:30:00Z",
    suiteFingerprint: null,
    finalError: null,
    aggregateCounts: {
      scenarioTotal: 1,
      scenarioPassedCount: 1,
      scenarioFailedCount: 0,
      scenarioHarnessFailedCount: 0,
      scenarioErroredCount: 0,
    },
    sourcePaths: null,
    endpointSnapshot: null,
    selectedScenarioIds: null,
    presetSnapshot: null,
    scenarios: [scenario({})],
  };
  return { ...base, ...partial };
}

describe("comparison controller", () => {
  test("aligns via preset snapshot when identical across runs", () => {
    const snapshot = {
      endpoint: "data/a.yaml",
      personas: "data/p.yaml",
      rubric: "data/r.yaml",
      selection: [{ file: "s.yaml", id: "s-1" }],
    };
    const runs = [
      run({ runId: "run-a", presetSnapshot: snapshot, presetId: "preset-a" }),
      run({ runId: "run-b", presetSnapshot: snapshot, presetId: "preset-a" }),
    ];
    expect(chooseAlignment(runs).alignment).toBe("preset_snapshot");
  });

  test("falls back to preset_id when snapshots differ but preset_id is shared", () => {
    const runs = [
      run({
        runId: "run-a",
        presetId: "preset-a",
        presetSnapshot: { endpoint: "a.yaml" },
      }),
      run({
        runId: "run-b",
        presetId: "preset-a",
        presetSnapshot: { endpoint: "b.yaml" },
      }),
    ];
    expect(chooseAlignment(runs).alignment).toBe("preset_id");
  });

  test("falls back to scenario_id when no preset info is shared", () => {
    const runs = [run({ runId: "run-a" }), run({ runId: "run-b" })];
    expect(chooseAlignment(runs).alignment).toBe("scenario_id");
  });

  test("uses file::id alignment when duplicate scenario ids span files", () => {
    const runs = [
      run({
        runId: "run-a",
        scenarios: [
          scenario({
            scenarioId: "dup",
            scenarioSnapshot: { sourceFile: "suite-a.yaml" },
          }),
          scenario({
            scenarioId: "dup",
            scenarioSnapshot: { sourceFile: "suite-b.yaml" },
            ordinal: 1,
            scenarioRunId: 2,
          }),
        ],
      }),
      run({ runId: "run-b" }),
    ];
    const { alignment } = chooseAlignment(runs);
    expect(alignment).toBe("file_scenario_id");
    const payload = buildComparisonPayload(runs);
    expect(payload.alignment).toBe("file_scenario_id");
    const keys = payload.scenarios.map((row) => row.alignment_key).sort();
    expect(keys).toContain("suite-a.yaml::dup");
    expect(keys).toContain("suite-b.yaml::dup");
  });

  test("emits delta_score, status_change, and present_in for missing scenarios", () => {
    const runs = [
      run({
        runId: "run-a",
        scenarios: [scenario({ scenarioId: "s-1", overallScore: 0.9 })],
      }),
      run({
        runId: "run-b",
        scenarios: [
          scenario({ scenarioId: "s-1", overallScore: 0.4, passed: false }),
        ],
      }),
      run({
        runId: "run-c",
        scenarios: [scenario({ scenarioId: "s-2", overallScore: 0.7 })],
      }),
    ];
    const payload = buildComparisonPayload(runs);
    const s1 = payload.scenarios.find((row) => row.scenario_id === "s-1");
    expect(s1).toBeDefined();
    expect(s1?.present_in.sort()).toEqual(["run-a", "run-b"].sort());
    expect(s1?.entries["run-c"].status).toBe("missing");
    expect(s1?.delta_score).toBeCloseTo(-0.5, 5);
    expect(s1?.status_change).toBe("mixed");
    const s2 = payload.scenarios.find((row) => row.scenario_id === "s-2");
    expect(s2?.present_in).toEqual(["run-c"]);
  });

  test("controller enforces 2–10 run id range and dedupes", async () => {
    const repository: ReadableRepository = {
      kind: "sqlite",
      dbUrl: "sqlite:///mem",
      initialize: async () => {},
      listRuns: async () => [],
      listRunsForPreset: async () => [],
      latestRunForSuite: async () => undefined,
      getRun: async (runId: string) => run({ runId }),
    };
    const controller = createComparisonController({ repository });

    await expect(controller.compare(["a"])).rejects.toThrow(
      new RegExp(`${MIN_COMPARISON_RUNS}`),
    );
    await expect(
      controller.compare(
        Array.from({ length: MAX_COMPARISON_RUNS + 1 }, (_, i) => `r${i}`),
      ),
    ).rejects.toThrow(new RegExp(`${MAX_COMPARISON_RUNS}`));

    const payload = await controller.compare(["a", "a", "b"]);
    expect(payload.runs.map((row) => row.run_id)).toEqual(["a", "b"]);
  });

  test("controller 404s when a run id cannot be resolved", async () => {
    const repository: ReadableRepository = {
      kind: "sqlite",
      dbUrl: "sqlite:///mem",
      initialize: async () => {},
      listRuns: async () => [],
      listRunsForPreset: async () => [],
      latestRunForSuite: async () => undefined,
      getRun: async () => undefined,
    };
    const controller = createComparisonController({ repository });
    await expect(
      controller.compare(["missing-a", "missing-b"]),
    ).rejects.toThrow(/not found/);
  });
});

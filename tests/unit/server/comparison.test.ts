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

const RUN_A = "11111111111111111111111111111111";
const RUN_B = "22222222222222222222222222222222";

function runId(index: number): string {
  return index.toString(16).padStart(32, "0");
}

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
    runId: RUN_A,
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
      run({ runId: RUN_A, presetSnapshot: snapshot, presetId: "preset-a" }),
      run({ runId: RUN_B, presetSnapshot: snapshot, presetId: "preset-a" }),
    ];
    expect(chooseAlignment(runs).alignment).toBe("preset_snapshot");
  });

  test("falls back to preset_id when snapshots differ but preset_id is shared", () => {
    const runs = [
      run({
        runId: RUN_A,
        presetId: "preset-a",
        presetSnapshot: { endpoint: "a.yaml" },
      }),
      run({
        runId: RUN_B,
        presetId: "preset-a",
        presetSnapshot: { endpoint: "b.yaml" },
      }),
    ];
    expect(chooseAlignment(runs).alignment).toBe("preset_id");
  });

  test("falls back to scenario_id when no preset info is shared", () => {
    const runs = [run({ runId: RUN_A }), run({ runId: RUN_B })];
    expect(chooseAlignment(runs).alignment).toBe("scenario_id");
  });

  test("uses file::id alignment when duplicate scenario ids span files", () => {
    const runs = [
      run({
        runId: RUN_A,
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
      run({ runId: RUN_B }),
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
        runId: RUN_A,
        scenarios: [scenario({ scenarioId: "s-1", overallScore: 0.9 })],
      }),
      run({
        runId: RUN_B,
        scenarios: [
          scenario({ scenarioId: "s-1", overallScore: 0.4, passed: false }),
        ],
      }),
      run({
        runId: "33333333333333333333333333333333",
        scenarios: [scenario({ scenarioId: "s-2", overallScore: 0.7 })],
      }),
    ];
    const payload = buildComparisonPayload(runs);
    const s1 = payload.scenarios.find((row) => row.scenario_id === "s-1");
    expect(s1).toBeDefined();
    expect(s1?.present_in.sort()).toEqual([RUN_A, RUN_B].sort());
    expect(s1?.entries["33333333333333333333333333333333"].status).toBe(
      "missing",
    );
    expect(s1?.delta_score).toBeCloseTo(-0.5, 5);
    expect(s1?.status_change).toBe("mixed");
    const s2 = payload.scenarios.find((row) => row.scenario_id === "s-2");
    expect(s2?.present_in).toEqual(["33333333333333333333333333333333"]);
  });

  test("controller enforces run id validation", async () => {
    const repository: ReadableRepository = {
      kind: "sqlite",
      dbUrl: "sqlite:///mem",
      listRuns: async () => [],
      listRunsForPreset: async () => [],
      latestRunForSuite: async () => undefined,
      getRun: async (runId: string) => run({ runId }),
    };
    const controller = createComparisonController({ repository });

    await expect(controller.compare([RUN_A])).rejects.toThrow(
      new RegExp(`${MIN_COMPARISON_RUNS}`),
    );
    await expect(
      controller.compare(
        Array.from({ length: MAX_COMPARISON_RUNS + 1 }, (_v, i) =>
          runId(i + 1),
        ),
      ),
    ).rejects.toThrow(new RegExp(`${MAX_COMPARISON_RUNS}`));
    await expect(controller.compare([RUN_A, "not-a-uuid"])).rejects.toThrow(
      /UUIDs/,
    );
    await expect(controller.compare([RUN_A, RUN_A])).rejects.toThrow(
      /duplicates/,
    );

    const payload = await controller.compare([RUN_A, RUN_B]);
    expect(payload.runs.map((row) => row.run_id)).toEqual([RUN_A, RUN_B]);
  });

  test("controller 404s when a run id cannot be resolved", async () => {
    const repository: ReadableRepository = {
      kind: "sqlite",
      dbUrl: "sqlite:///mem",
      listRuns: async () => [],
      listRunsForPreset: async () => [],
      latestRunForSuite: async () => undefined,
      getRun: async () => undefined,
    };
    const controller = createComparisonController({ repository });
    await expect(controller.compare([RUN_A, RUN_B])).rejects.toThrow(
      /not found/,
    );
  });
});

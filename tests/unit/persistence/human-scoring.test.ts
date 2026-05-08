import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { SqliteRepository } from "../../../src/providers/persistence/sqlite-backend.ts";
import {
  adapterReply,
  buildPersona,
  buildRubric,
  buildScenario,
  buildScore,
  makeTempDir,
} from "../support.ts";

async function seedScenario(repo: SqliteRepository): Promise<{
  runId: string;
  scenarioRunId: number;
}> {
  const recorder = repo.createRecorder();
  const runId = await recorder.recordRunStarted({
    endpoint: "data/endpoints.yaml",
    scenarios: "data/scenarios.yaml",
    personas: "data/personas.yaml",
    rubric: "data/rubric.yaml",
    trigger: "human-scoring-test",
  });
  const persona = buildPersona();
  const rubric = buildRubric();
  const scenario = buildScenario({ id: "human-test", name: "Human Test" });
  await recorder.recordRunConfiguration({
    endpointConfig: {
      metadata: { sourcePath: "data/endpoints.yaml" },
      transport: "http",
      preset: "human-test",
      connection: { baseUrl: "https://example.test" },
      endpoints: {},
    },
    scenarioCollection: { scenarios: [scenario] },
    personaCollection: { personas: [persona] },
    rubricCollection: { rubrics: [rubric] },
    selectedScenarios: [scenario],
  });
  const scenarioRunId = await recorder.recordScenarioStarted({
    scenario,
    persona,
    rubric,
    ordinal: 0,
  });
  await recorder.recordTurn(scenarioRunId, {
    turnIndex: 0,
    turn: { role: "user", content: "hi" },
    source: "user_exact",
  });
  await recorder.recordTurn(scenarioRunId, {
    turnIndex: 1,
    turn: { role: "assistant", content: "hello" },
    source: "assistant",
  });
  await recorder.recordAssistantReply(scenarioRunId, {
    turnIndex: 1,
    reply: adapterReply("hello", {
      toolCalls: [],
      rawExchange: {},
      latencyMs: 1,
      usage: {},
    }),
  });
  await recorder.recordJudgeResult(scenarioRunId, {
    rubric,
    score: buildScore({ score: 4 }),
    overallScore: 0.8,
  });
  await recorder.recordScenarioFinished(scenarioRunId, {
    result: {
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      personaId: persona.id,
      rubricId: rubric.id,
      passed: true,
      overallScore: 0.8,
      transcript: [],
      checkpoints: [],
      judgeScore: buildScore({ score: 4 }),
    },
  });
  await recorder.recordRunFinished({
    runId,
    passed: true,
    exitCode: 0,
    results: [],
  });
  return { runId, scenarioRunId };
}

describe("human scoring (sqlite)", () => {
  test("listHumanScoringRubrics returns dimensions with full unscored count", async () => {
    const dir = makeTempDir("human-scoring-list");
    const url = `sqlite:///${join(dir, "runs.sqlite3")}`;
    const repo = new SqliteRepository(url);
    await repo.initialize();
    await seedScenario(repo);
    await seedScenario(repo);

    const rubrics = await repo.listHumanScoringRubrics();
    expect(rubrics).toHaveLength(1);
    expect(rubrics[0]?.rubricId).toBe("customer-support");
    expect(rubrics[0]?.totalScenarios).toBe(2);
    expect(rubrics[0]?.dimensions).toHaveLength(1);
    expect(rubrics[0]?.dimensions[0]?.id).toBe("task_completion");
    expect(rubrics[0]?.dimensions[0]?.unscored).toBe(2);
  });

  test("getNextUnscoredScenario returns a chat with turns and skips after scoring", async () => {
    const dir = makeTempDir("human-scoring-next");
    const url = `sqlite:///${join(dir, "runs.sqlite3")}`;
    const repo = new SqliteRepository(url);
    await repo.initialize();
    const seeded = await seedScenario(repo);

    const first = await repo.getNextUnscoredScenario(
      "customer-support",
      "task_completion",
    );
    expect(first).not.toBeNull();
    expect(first?.scenarioRunId).toBe(seeded.scenarioRunId);
    expect(first?.runId).toBe(seeded.runId);
    expect(first?.remaining).toBe(1);
    expect(first?.turns.length).toBeGreaterThan(0);
    expect(first?.judgeDimensionRawScore).toBe(4);

    await repo.recordHumanScore({
      scenarioRunId: seeded.scenarioRunId,
      dimensionId: "task_completion",
      dimensionName: "Task Completion",
      scaleType: "likert",
      scalePoints: 5,
      rawScore: 5,
    });

    const second = await repo.getNextUnscoredScenario(
      "customer-support",
      "task_completion",
    );
    expect(second).toBeNull();

    const rubrics = await repo.listHumanScoringRubrics();
    expect(rubrics[0]?.dimensions[0]?.unscored).toBe(0);
  });

  test("recordHumanScore is upsert (last write wins per (scenario, dimension))", async () => {
    const dir = makeTempDir("human-scoring-upsert");
    const dbPath = join(dir, "runs.sqlite3");
    const url = `sqlite:///${dbPath}`;
    const repo = new SqliteRepository(url);
    await repo.initialize();
    const { scenarioRunId } = await seedScenario(repo);

    await repo.recordHumanScore({
      scenarioRunId,
      dimensionId: "task_completion",
      dimensionName: "Task Completion",
      scaleType: "likert",
      scalePoints: 5,
      rawScore: 2,
    });
    await repo.recordHumanScore({
      scenarioRunId,
      dimensionId: "task_completion",
      dimensionName: "Task Completion",
      scaleType: "likert",
      scalePoints: 5,
      rawScore: 5,
    });

    const db = new Database(dbPath, { readonly: true });
    try {
      const rows = db
        .query(
          "select raw_score, normalized_score from human_dimension_scores where scenario_run_id = ?",
        )
        .all(scenarioRunId) as Array<{
        raw_score: number;
        normalized_score: number;
      }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.raw_score).toBe(5);
      expect(rows[0]?.normalized_score).toBeCloseTo(1, 5);
    } finally {
      db.close();
    }
  });

  test("getNextUnscoredScenario ignores non-completed scenario_runs", async () => {
    const dir = makeTempDir("human-scoring-status");
    const url = `sqlite:///${join(dir, "runs.sqlite3")}`;
    const repo = new SqliteRepository(url);
    await repo.initialize();

    const recorder = repo.createRecorder();
    await recorder.recordRunStarted({
      endpoint: "data/endpoints.yaml",
      scenarios: "data/scenarios.yaml",
      personas: "data/personas.yaml",
      rubric: "data/rubric.yaml",
      trigger: "human-scoring-status",
    });
    await recorder.recordRunConfiguration({
      endpointConfig: {
        metadata: { sourcePath: "data/endpoints.yaml" },
        transport: "http",
        preset: "status",
        connection: { baseUrl: "https://example.test" },
        endpoints: {},
      },
      scenarioCollection: { scenarios: [buildScenario({ id: "s1" })] },
      personaCollection: { personas: [buildPersona()] },
      rubricCollection: { rubrics: [buildRubric()] },
      selectedScenarios: [buildScenario({ id: "s1" })],
    });
    const scenarioRunId = await recorder.recordScenarioStarted({
      scenario: buildScenario({ id: "s1" }),
      persona: buildPersona(),
      rubric: buildRubric(),
      ordinal: 0,
    });
    // Force a runtime error so the scenario is not 'completed'.
    await recorder.recordScenarioError(scenarioRunId, new Error("boom"));

    const next = await repo.getNextUnscoredScenario(
      "customer-support",
      "task_completion",
    );
    expect(next).toBeNull();
  });
});

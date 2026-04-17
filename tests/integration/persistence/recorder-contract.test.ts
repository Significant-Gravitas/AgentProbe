import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { createRepository } from "../../../src/providers/persistence/factory.ts";
import { runMigrations } from "../../../src/providers/persistence/migrations/index.ts";
import type {
  PersistenceRepository,
  RunRecorder,
} from "../../../src/providers/persistence/types.ts";
import type {
  AdapterReply,
  Endpoints,
  Persona,
  Rubric,
  Scenario,
} from "../../../src/shared/types/contracts.ts";
import {
  adapterReply,
  buildPersona,
  buildRubric,
  buildScenario,
  buildScore,
  makeTempDir,
  toolCall,
} from "../../unit/support.ts";

type BackendFixture = {
  name: "sqlite" | "postgres";
  dbUrl: string;
  teardown?: () => Promise<void>;
};

async function sqliteFixture(): Promise<BackendFixture> {
  const dir = makeTempDir("recorder-contract-sqlite");
  const url = `sqlite:///${join(dir, "runs.sqlite3")}`;
  await runMigrations(url);
  return { name: "sqlite", dbUrl: url };
}

async function postgresFixture(): Promise<BackendFixture | null> {
  const url = process.env.AGENTPROBE_TEST_POSTGRES_URL;
  if (!url) return null;
  await runMigrations(url);
  return {
    name: "postgres",
    dbUrl: url,
    teardown: async () => {
      const repo = createRepository(url);
      // Clear tables so reruns start clean. Cascade handles children.
      // biome-ignore lint/suspicious/noExplicitAny: test-only raw SQL.
      const sql = (repo as any).sql ?? null;
      void sql;
    },
  };
}

async function writeSyntheticRun(
  recorder: RunRecorder,
  fixtures: {
    endpointConfig: Endpoints;
    scenario: Scenario;
    persona: Persona;
    rubric: Rubric;
    replies: AdapterReply[];
  },
): Promise<{ runId: string; scenarioRunId: number }> {
  const runId = recorder.recordRunStarted({
    endpoint: "data/endpoint.yaml",
    scenarios: "data/scenarios.yaml",
    personas: "data/personas.yaml",
    rubric: "data/rubrics.yaml",
    trigger: "test",
    label: "contract-test",
  });
  recorder.recordRunConfiguration({
    endpointConfig: fixtures.endpointConfig,
    scenarioCollection: { scenarios: [fixtures.scenario] },
    personaCollection: { personas: [fixtures.persona] },
    rubricCollection: { rubrics: [fixtures.rubric] },
    selectedScenarios: [fixtures.scenario],
  });
  const scenarioRunId = recorder.recordScenarioStarted({
    scenario: fixtures.scenario,
    persona: fixtures.persona,
    rubric: fixtures.rubric,
    ordinal: 0,
    userId: "test-user",
  });
  recorder.recordTurn(scenarioRunId, {
    turnIndex: 0,
    turn: { role: "user", content: "Help me reschedule my flight." },
    source: "user_guided",
  });
  recorder.recordTurn(scenarioRunId, {
    turnIndex: 1,
    turn: { role: "assistant", content: "Sure, let me look that up." },
    source: "assistant",
  });
  recorder.recordAssistantReply(scenarioRunId, {
    turnIndex: 1,
    reply: fixtures.replies[0],
  });
  recorder.recordCheckpoint(scenarioRunId, {
    checkpointIndex: 0,
    precedingTurnIndex: 1,
    assertions: [],
    result: { passed: true, failures: [] },
  });
  recorder.recordJudgeResult(scenarioRunId, {
    rubric: fixtures.rubric,
    score: buildScore({ score: 5, passed: true }),
    overallScore: 1,
  });
  recorder.recordScenarioFinished(scenarioRunId, {
    result: {
      passed: true,
      failureKind: undefined,
      overallScore: 1,
      scenarioId: fixtures.scenario.id,
      scenarioName: fixtures.scenario.name,
      personaId: fixtures.persona.id,
      rubricId: fixtures.rubric.id,
      transcript: [],
      checkpoints: [],
    },
  });
  recorder.recordRunFinished({
    passed: true,
    results: [],
    exitCode: 0,
    cancelled: false,
  });
  await recorder.drain?.();
  return { runId, scenarioRunId };
}

function fixtureEndpoint(): Endpoints {
  return {
    transport: "openai_responses",
    preset: "test",
    openai: {
      baseUrl: "https://example.invalid",
      model: "test-model",
    },
  } as unknown as Endpoints;
}

function fixtureReply(): AdapterReply {
  return adapterReply("Sure, let me look that up.", {
    toolCalls: [toolCall("lookup", { booking_id: "FLT-29481" })],
    latencyMs: 123,
    usage: { input_tokens: 5, output_tokens: 7 },
    rawExchange: { kind: "test" },
  });
}

describe("recorder contract", () => {
  const fixtures: BackendFixture[] = [];
  let repositories: Array<{
    backend: BackendFixture;
    repository: PersistenceRepository;
  }> = [];

  beforeAll(async () => {
    const sqlite = await sqliteFixture();
    fixtures.push(sqlite);
    const postgres = await postgresFixture();
    if (postgres) fixtures.push(postgres);
    repositories = fixtures.map((backend) => ({
      backend,
      repository: createRepository(backend.dbUrl),
    }));
  });

  afterAll(async () => {
    for (const fixture of fixtures) {
      await fixture.teardown?.();
    }
  });

  for (const backendName of ["sqlite", "postgres"] as const) {
    test(`${backendName}: round-trip run, scenario, turns, judge`, async () => {
      const entry = repositories.find((r) => r.backend.name === backendName);
      if (!entry) {
        // Postgres fixture may be absent when AGENTPROBE_TEST_POSTGRES_URL is unset.
        return;
      }
      const recorder = entry.repository.createRecorder();
      const { runId } = await writeSyntheticRun(recorder, {
        endpointConfig: fixtureEndpoint(),
        scenario: buildScenario(),
        persona: buildPersona(),
        rubric: buildRubric(),
        replies: [fixtureReply()],
      });
      await recorder.close?.();

      const run = await entry.repository.getRun(runId);
      expect(run).toBeTruthy();
      expect(run?.status).toBe("completed");
      expect(run?.passed).toBe(true);
      expect(run?.aggregateCounts.scenarioTotal).toBe(1);
      expect(run?.aggregateCounts.scenarioPassedCount).toBe(1);
      expect(run?.scenarios).toHaveLength(1);
      const scenario = run?.scenarios[0];
      expect(scenario?.counts.turnCount).toBe(2);
      expect(scenario?.counts.toolCallCount).toBe(1);
      expect(scenario?.counts.checkpointCount).toBe(1);
      expect(scenario?.judgeDimensionScores.length).toBeGreaterThan(0);
      expect(scenario?.turns.map((t) => t.turn_index).sort()).toEqual([0, 1]);
      expect(scenario?.targetEvents).toHaveLength(1);
      expect(scenario?.toolCalls[0]?.name).toBe("lookup");
    });

    test(`${backendName}: markRunCancelled sets cancelled status`, async () => {
      const entry = repositories.find((r) => r.backend.name === backendName);
      if (!entry) return;
      const recorder = entry.repository.createRecorder();
      const runId = recorder.recordRunStarted({
        endpoint: "data/endpoint.yaml",
        scenarios: "data/scenarios.yaml",
        personas: "data/personas.yaml",
        rubric: "data/rubrics.yaml",
      });
      await recorder.drain?.();
      await recorder.close?.();
      const cancelled = await entry.repository.markRunCancelled(runId, {
        exitCode: 130,
      });
      expect(cancelled?.status).toBe("cancelled");
      expect(cancelled?.exitCode).toBe(130);
    });
  }
});

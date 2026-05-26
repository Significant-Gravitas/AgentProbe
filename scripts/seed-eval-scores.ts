/**
 * One-off seeder that writes a run + scenario_runs + retrieval/demotion/
 * procedure/dedup scores into the SQLite DB so the dashboard EvalScoresView
 * has real data to render. Intended for local-dev demo / smoke testing.
 *
 * Usage:
 *   AGENTPROBE_DB_URL="sqlite:///$(pwd)/data/.agentprobe/runs.sqlite3" \
 *     bun run scripts/seed-eval-scores.ts
 */

import { randomUUID } from "node:crypto";

import { scoreScenarioDedup } from "../src/domains/evaluation/dedup-scorer.ts";
import { scoreScenarioDemotion } from "../src/domains/evaluation/demotion-scorer.ts";
import { scoreScenarioProcedure } from "../src/domains/evaluation/procedure-scorer.ts";
import { scoreRetrieval } from "../src/domains/evaluation/retrieval-scorer.ts";
import {
  parseRubricsYaml,
  parseScenarioYaml,
} from "../src/domains/validation/load-suite.ts";
import { SqliteRunRecorder } from "../src/providers/persistence/sqlite-run-history.ts";

const dbUrl =
  Bun.env.AGENTPROBE_DB_URL ??
  `sqlite:///${process.cwd()}/data/.agentprobe/runs.sqlite3`;

console.log(`Seeding eval scores into ${dbUrl}`);

const rubrics = parseRubricsYaml(`${process.cwd()}/data/rubric.yaml`).rubrics;

const dreamScenarios = parseScenarioYaml(
  `${process.cwd()}/data/dream-validation.yaml`,
);
const retrievalScenarios = parseScenarioYaml(
  `${process.cwd()}/data/retrieval-memory.yaml`,
);

const recorder = new SqliteRunRecorder(dbUrl);

const runId = await recorder.recordRunStarted({
  endpoint: "data/autogpt-endpoint.yaml",
  scenarios: "data/dream-validation.yaml + data/retrieval-memory.yaml",
  personas: "data/personas.yaml",
  rubric: "data/rubric.yaml",
  label: "eval-scores demo seed",
  notes: "seeded by scripts/seed-eval-scores.ts to populate the dashboard",
  trigger: "manual",
});
console.log(`Run id: ${runId}`);

const allScenarios = [
  ...dreamScenarios.scenarios,
  ...retrievalScenarios.scenarios,
];
const personaSnapshot = {
  id: "smb-founder",
  name: "SMB Founder",
};
let ordinal = 1;

for (const scenario of allScenarios) {
  const rubric = rubrics.find((r) => r.id === scenario.rubric);
  if (!rubric) {
    console.warn(`Skipping ${scenario.id}: no rubric resolved`);
    continue;
  }

  const scenarioRunId = await recorder.recordScenarioStarted({
    scenario,
    persona: {
      id: personaSnapshot.id,
      name: personaSnapshot.name,
      demographics: {
        role: "founder",
        techLiteracy: "high",
        domainExpertise: "intermediate",
        languageStyle: "terse",
      },
      personality: {
        patience: 3,
        assertiveness: 4,
        detailOrientation: 4,
        cooperativeness: 4,
        emotionalIntensity: 2,
      },
      behavior: {
        openingStyle: "direct",
        followUpStyle: "concise",
        escalationTriggers: [],
        topicDrift: "low",
        clarificationCompliance: "high",
      },
      systemPrompt: "You are an SMB founder.",
    },
    rubric,
    ordinal,
    userId: randomUUID(),
  });

  await recorder.recordJudgeResult(scenarioRunId, {
    rubric,
    score: {
      dimensions: Object.fromEntries(
        rubric.dimensions.map((dim) => [
          dim.id,
          {
            reasoning: "Synthetic seed data.",
            evidence: ["seed"],
            score: dim.scale.points ?? 1,
          },
        ]),
      ),
      overallNotes: "Synthetic seed",
      passed: true,
    },
    overallScore: 1.0,
  });

  const evalContext = {
    scenariosPath:
      `${process.cwd()}/data/` +
      (scenario.dedup || scenario.demotion || scenario.procedure
        ? "dream-validation.yaml"
        : "retrieval-memory.yaml"),
  };

  let allPassed = true;
  const retrieval = scoreRetrieval(scenario, evalContext);
  if (retrieval) {
    await recorder.recordRetrievalResult(scenarioRunId, {
      scenario,
      score: retrieval,
    });
    allPassed = allPassed && retrieval.passed;
  }
  const demotion = scoreScenarioDemotion(scenario, evalContext);
  if (demotion) {
    await recorder.recordDemotionResult(scenarioRunId, {
      scenario,
      score: demotion,
    });
    allPassed = allPassed && demotion.passed;
  }
  const procedure = scoreScenarioProcedure(scenario, evalContext);
  if (procedure) {
    await recorder.recordProcedureResult(scenarioRunId, {
      scenario,
      score: procedure,
    });
    allPassed = allPassed && procedure.passed;
  }
  const dedup = scoreScenarioDedup(scenario, evalContext);
  if (dedup) {
    await recorder.recordDedupResult(scenarioRunId, {
      scenario,
      score: dedup,
    });
    allPassed = allPassed && dedup.passed;
  }

  await recorder.recordScenarioFinished(scenarioRunId, {
    result: {
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      personaId: "smb-founder",
      rubricId: rubric.id,
      passed: allPassed,
      overallScore: 1.0,
      transcript: [],
      checkpoints: [],
    },
  });
  ordinal += 1;
  console.log(
    `  [${ordinal - 1}/${allScenarios.length}] ${scenario.id}: passed=${allPassed}`,
  );
}

await recorder.recordRunFinished({
  runId,
  passed: true,
  exitCode: 0,
  results: [],
});

console.log(`Seeded ${ordinal - 1} scenarios in run ${runId}`);

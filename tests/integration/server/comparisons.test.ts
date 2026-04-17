import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { initDb } from "../../../src/providers/persistence/sqlite-run-history.ts";
import {
  type StartedServer,
  startAgentProbeServer,
} from "../../../src/runtime/server/app-server.ts";
import { buildServerConfig } from "../../../src/runtime/server/config.ts";
import { makeTempDir } from "../../unit/support.ts";

function writeSuite(root: string): string {
  const data = join(root, "data");
  mkdirSync(data, { recursive: true });
  writeFileSync(
    join(data, "endpoint.yaml"),
    [
      "transport: http",
      "connection:",
      "  base_url: http://example.test",
      "request:",
      "  method: POST",
      '  url: "{{ base_url }}/chat"',
      "  body_template: '{}'",
      "response:",
      "  format: text",
      '  content_path: "$"',
      "",
    ].join("\n"),
    "utf8",
  );
  return data;
}

type SeedOptions = {
  runId: string;
  startedAt: string;
  presetId?: string | null;
  presetSnapshot?: Record<string, unknown> | null;
  scenarios: Array<{
    scenarioId: string;
    passed: boolean;
    overallScore: number;
    failureKind?: "harness" | "agent" | null;
    sourceFile?: string | null;
  }>;
};

const RUN_A = "11111111111111111111111111111111";
const RUN_B = "22222222222222222222222222222222";
const RUN_C = "33333333333333333333333333333333";

function runId(index: number): string {
  return index.toString(16).padStart(32, "0");
}

function seedRun(dbPath: string, options: SeedOptions): void {
  const dbUrl = `sqlite:///${dbPath}`;
  initDb(dbUrl);
  const database = new Database(dbPath);
  try {
    const scenarioTotal = options.scenarios.length;
    const scenarioPassed = options.scenarios.filter((s) => s.passed).length;
    const scenarioFailed = scenarioTotal - scenarioPassed;
    database
      .query(
        `insert into runs (
          id, status, passed, exit_code, preset, preset_id, preset_snapshot_json,
          suite_fingerprint, started_at, updated_at, completed_at,
          scenario_total, scenario_passed_count, scenario_failed_count,
          scenario_errored_count
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        options.runId,
        "completed",
        scenarioPassed === scenarioTotal ? 1 : 0,
        0,
        "smoke-preset",
        options.presetId ?? null,
        options.presetSnapshot ? JSON.stringify(options.presetSnapshot) : null,
        "fp",
        options.startedAt,
        options.startedAt,
        options.startedAt,
        scenarioTotal,
        scenarioPassed,
        scenarioFailed,
        0,
      );
    for (let index = 0; index < options.scenarios.length; index += 1) {
      const scenario = options.scenarios[index];
      if (!scenario) continue;
      database
        .query(
          `insert into scenario_runs (
            run_id, ordinal, scenario_id, scenario_name, persona_id, rubric_id,
            scenario_snapshot_json, status, passed, failure_kind, overall_score,
            pass_threshold, turn_count, assistant_turn_count, tool_call_count,
            checkpoint_count, started_at, updated_at, completed_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          options.runId,
          index,
          scenario.scenarioId,
          `${scenario.scenarioId} name`,
          "analyst",
          "support",
          scenario.sourceFile
            ? JSON.stringify({ sourceFile: scenario.sourceFile })
            : null,
          "completed",
          scenario.passed ? 1 : 0,
          scenario.failureKind ?? null,
          scenario.overallScore,
          0.7,
          0,
          0,
          0,
          0,
          options.startedAt,
          options.startedAt,
          options.startedAt,
        );
    }
  } finally {
    database.close();
  }
}

type ComparisonResponse = {
  alignment: string;
  runs: Array<{ run_id: string }>;
  scenarios: Array<{
    scenario_id: string;
    alignment_key: string;
    status_change: string;
    delta_score: number | null;
    present_in: string[];
    entries: Record<string, { status: string; score: number | null }>;
  }>;
  summary: {
    total_scenarios: number;
    scenarios_regressed: number;
    scenarios_improved: number;
  };
};

async function expectBadRequest(response: Response): Promise<void> {
  expect(response.status).toBe(400);
  const body = (await response.json()) as {
    error?: { code?: string; type?: string };
  };
  expect(body.error?.code).toBe("bad_request");
  expect(body.error?.type).toBe("bad_request");
}

describe("/api/comparisons integration", () => {
  const servers: StartedServer[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await server.stop();
    }
  });

  async function startServerWithRuns(
    seeds: SeedOptions[],
  ): Promise<StartedServer> {
    const root = makeTempDir("comparison-server");
    const dataPath = writeSuite(root);
    const dbPath = join(root, "runs.sqlite3");
    for (const seed of seeds) {
      seedRun(dbPath, seed);
    }
    const config = buildServerConfig({
      args: [
        "--host",
        "127.0.0.1",
        "--port",
        "0",
        "--data",
        dataPath,
        "--db",
        dbPath,
      ],
      env: {},
    });
    const server = await startAgentProbeServer(config);
    servers.push(server);
    return server;
  }

  test("returns comparison payload for 2 runs", async () => {
    const snapshot = {
      endpoint: "data/endpoint.yaml",
      personas: "data/p.yaml",
      rubric: "data/r.yaml",
      selection: [{ file: "data/s.yaml", id: "s-1" }],
    };
    const server = await startServerWithRuns([
      {
        runId: RUN_A,
        startedAt: "2026-04-17T10:00:00.000Z",
        presetId: "preset-1",
        presetSnapshot: snapshot,
        scenarios: [
          { scenarioId: "s-1", passed: true, overallScore: 0.9 },
          { scenarioId: "s-2", passed: true, overallScore: 0.8 },
        ],
      },
      {
        runId: RUN_B,
        startedAt: "2026-04-17T11:00:00.000Z",
        presetId: "preset-1",
        presetSnapshot: snapshot,
        scenarios: [
          {
            scenarioId: "s-1",
            passed: false,
            overallScore: 0.4,
            failureKind: "agent",
          },
          { scenarioId: "s-2", passed: true, overallScore: 0.85 },
        ],
      },
    ]);

    const response = await fetch(
      `${server.url}/api/comparisons?run_ids=${RUN_A},${RUN_B}`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as ComparisonResponse;
    expect(body.alignment).toBe("preset_snapshot");
    expect(body.runs.map((r) => r.run_id)).toEqual([RUN_A, RUN_B]);
    const s1 = body.scenarios.find((row) => row.scenario_id === "s-1");
    expect(s1).toBeDefined();
    expect(s1?.delta_score ?? 0).toBeCloseTo(-0.5, 5);
    expect(s1?.status_change).toBe("regressed");
    expect(body.summary.scenarios_regressed).toBe(1);
  });

  test("aligns via file::id when scenario_ids collide across files", async () => {
    const server = await startServerWithRuns([
      {
        runId: RUN_A,
        startedAt: "2026-04-17T10:00:00.000Z",
        scenarios: [
          {
            scenarioId: "dup",
            passed: true,
            overallScore: 0.9,
            sourceFile: "suite-a.yaml",
          },
          {
            scenarioId: "dup",
            passed: false,
            overallScore: 0.2,
            sourceFile: "suite-b.yaml",
          },
        ],
      },
      {
        runId: RUN_B,
        startedAt: "2026-04-17T11:00:00.000Z",
        scenarios: [
          {
            scenarioId: "dup",
            passed: true,
            overallScore: 0.85,
            sourceFile: "suite-a.yaml",
          },
          {
            scenarioId: "dup",
            passed: true,
            overallScore: 0.65,
            sourceFile: "suite-b.yaml",
          },
        ],
      },
    ]);

    const response = await fetch(
      `${server.url}/api/comparisons?run_ids=${RUN_A},${RUN_B}`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as ComparisonResponse;
    expect(body.alignment).toBe("file_scenario_id");
    const keys = body.scenarios.map((row) => row.alignment_key).sort();
    expect(keys).toEqual(["suite-a.yaml::dup", "suite-b.yaml::dup"]);
  });

  test("aligns 3 heterogeneous preset runs via file::id", async () => {
    const server = await startServerWithRuns([
      {
        runId: RUN_A,
        startedAt: "2026-04-17T10:00:00.000Z",
        presetId: "preset-a",
        presetSnapshot: { endpoint: "a.yaml", selection: [] },
        scenarios: [
          {
            scenarioId: "dup",
            passed: true,
            overallScore: 0.9,
            sourceFile: "suite-a.yaml",
          },
          {
            scenarioId: "dup",
            passed: false,
            overallScore: 0.2,
            sourceFile: "suite-b.yaml",
          },
        ],
      },
      {
        runId: RUN_B,
        startedAt: "2026-04-17T11:00:00.000Z",
        presetId: "preset-b",
        presetSnapshot: { endpoint: "b.yaml", selection: [] },
        scenarios: [
          {
            scenarioId: "dup",
            passed: true,
            overallScore: 0.85,
            sourceFile: "suite-a.yaml",
          },
          {
            scenarioId: "dup",
            passed: true,
            overallScore: 0.65,
            sourceFile: "suite-b.yaml",
          },
        ],
      },
      {
        runId: RUN_C,
        startedAt: "2026-04-17T12:00:00.000Z",
        presetId: "preset-c",
        presetSnapshot: { endpoint: "c.yaml", selection: [] },
        scenarios: [
          {
            scenarioId: "dup",
            passed: false,
            overallScore: 0.4,
            sourceFile: "suite-a.yaml",
          },
          {
            scenarioId: "dup",
            passed: true,
            overallScore: 0.75,
            sourceFile: "suite-b.yaml",
          },
        ],
      },
    ]);

    const response = await fetch(
      `${server.url}/api/comparisons?run_ids=${RUN_A},${RUN_B},${RUN_C}`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as ComparisonResponse;
    expect(body.alignment).toBe("file_scenario_id");
    expect(body.runs.map((r) => r.run_id)).toEqual([RUN_A, RUN_B, RUN_C]);
    expect(body.scenarios.map((row) => row.alignment_key).sort()).toEqual([
      "suite-a.yaml::dup",
      "suite-b.yaml::dup",
    ]);
  });

  test("returns an empty alignment table when selected runs have no scenarios", async () => {
    const server = await startServerWithRuns([
      {
        runId: RUN_A,
        startedAt: "2026-04-17T10:00:00.000Z",
        scenarios: [],
      },
      {
        runId: RUN_B,
        startedAt: "2026-04-17T11:00:00.000Z",
        scenarios: [],
      },
    ]);

    const response = await fetch(
      `${server.url}/api/comparisons?run_ids=${RUN_A},${RUN_B}`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as ComparisonResponse;
    expect(body.scenarios).toEqual([]);
    expect(body.summary.total_scenarios).toBe(0);
  });

  test("rejects invalid run_id input with structured bad_request errors", async () => {
    const server = await startServerWithRuns([]);

    await expectBadRequest(
      await fetch(`${server.url}/api/comparisons?run_ids=${RUN_A}`),
    );

    const tooManyIds = Array.from({ length: 11 }, (_v, i) => runId(i + 1)).join(
      ",",
    );
    await expectBadRequest(
      await fetch(`${server.url}/api/comparisons?run_ids=${tooManyIds}`),
    );

    await expectBadRequest(
      await fetch(`${server.url}/api/comparisons?run_ids=${RUN_A},not-a-uuid`),
    );

    await expectBadRequest(
      await fetch(`${server.url}/api/comparisons?run_ids=${RUN_A},${RUN_A}`),
    );
  });
});

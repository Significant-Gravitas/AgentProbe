import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  LiveDashboardState,
  startDashboardServer,
} from "../../src/domains/reporting/dashboard.ts";
import {
  DEFAULT_DB_FILENAME,
  initDb,
} from "../../src/providers/persistence/sqlite-run-history.ts";
import { makeTempDir } from "./support.ts";

function seedDashboardRun(): { dbUrl: string; runId: string; root: string } {
  const root = makeTempDir("dashboard");
  const dbPath = join(root, DEFAULT_DB_FILENAME);
  const dbUrl = `sqlite:///${dbPath}`;
  const runId = "run-dashboard";
  initDb(dbUrl);

  const database = new Database(dbPath);
  try {
    database
      .query(
        `insert into runs (
        id, status, passed, exit_code, suite_fingerprint, started_at, updated_at,
        completed_at, scenario_total, scenario_passed_count, scenario_failed_count,
        scenario_errored_count
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        runId,
        "completed",
        0,
        1,
        "suite-1",
        "2026-04-10T10:00:00Z",
        "2026-04-10T10:02:00Z",
        "2026-04-10T10:02:00Z",
        2,
        1,
        1,
        0,
      );

    database
      .query(
        `insert into scenario_runs (
        run_id, ordinal, scenario_id, scenario_name, persona_id, rubric_id, user_id,
        status, passed, overall_score, pass_threshold, judge_provider, judge_model,
        judge_temperature, judge_max_tokens, overall_notes, judge_output_json,
        turn_count, assistant_turn_count, tool_call_count, checkpoint_count,
        started_at, updated_at, completed_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        runId,
        0,
        "smoke",
        "Smoke",
        "persona-1",
        "rubric-1",
        "user-1",
        "completed",
        1,
        0.9,
        0.7,
        "openai",
        "anthropic/claude-opus-4.6",
        0,
        500,
        "Strong memory recall.",
        JSON.stringify({ failure_mode_detected: null }),
        2,
        1,
        0,
        0,
        "2026-04-10T10:00:00Z",
        "2026-04-10T10:01:00Z",
        "2026-04-10T10:01:00Z",
      );
    database
      .query(
        `insert into scenario_runs (
        run_id, ordinal, scenario_id, scenario_name, persona_id, rubric_id, user_id,
        status, passed, overall_score, pass_threshold, judge_provider, judge_model,
        judge_temperature, judge_max_tokens, overall_notes, judge_output_json,
        turn_count, assistant_turn_count, tool_call_count, checkpoint_count,
        started_at, updated_at, completed_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        runId,
        1,
        "smoke",
        "Smoke",
        "persona-1",
        "rubric-1",
        "user-2",
        "completed",
        0,
        0.4,
        0.7,
        "openai",
        "anthropic/claude-opus-4.6",
        0,
        500,
        "Missed the stored fact.",
        JSON.stringify({ failure_mode_detected: "fabrication" }),
        2,
        1,
        0,
        0,
        "2026-04-10T10:01:00Z",
        "2026-04-10T10:02:00Z",
        "2026-04-10T10:02:00Z",
      );

    database
      .query(
        `insert into turns (
        scenario_run_id, turn_index, role, source, content, created_at
      ) values (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        1,
        0,
        "user",
        "user_exact",
        "Remember Sarah.",
        "2026-04-10T10:00:01Z",
      );
    database
      .query(
        `insert into turns (
        scenario_run_id, turn_index, role, source, content, created_at
      ) values (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        2,
        0,
        "system",
        "session_boundary",
        "--- Session boundary: session_id: probe reset_policy: fresh_agent time_offset: 24h user_id: user-2 ---",
        "2026-04-10T10:01:01Z",
      );

    database
      .query(
        `insert into judge_dimension_scores (
        scenario_run_id, dimension_id, dimension_name, weight, scale_type, scale_points,
        raw_score, normalized_score, reasoning, evidence_json, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        1,
        "task_completion",
        "Task Completion",
        1,
        "likert",
        5,
        4.5,
        0.9,
        "Remembered the fact.",
        JSON.stringify(["Named Sarah"]),
        "2026-04-10T10:01:00Z",
      );
    database
      .query(
        `insert into judge_dimension_scores (
        scenario_run_id, dimension_id, dimension_name, weight, scale_type, scale_points,
        raw_score, normalized_score, reasoning, evidence_json, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        2,
        "task_completion",
        "Task Completion",
        1,
        "likert",
        5,
        2,
        0.4,
        "Forgot the fact.",
        JSON.stringify(["Asked again"]),
        "2026-04-10T10:02:00Z",
      );
  } finally {
    database.close();
  }

  return { dbUrl, runId, root };
}

describe("dashboard", () => {
  const servers: Array<{ stop: () => void }> = [];

  afterEach(() => {
    for (const server of servers.splice(0)) {
      server.stop();
    }
  });

  test("aggregates live progress events into dashboard counters", () => {
    const state = new LiveDashboardState();
    state.primeScenarios([
      { ordinal: 0, displayId: "smoke", scenarioName: "Smoke" },
      { ordinal: 1, displayId: "smoke#2", scenarioName: "Smoke" },
      { ordinal: 2, displayId: "other", scenarioName: "Other" },
    ]);
    state.handleProgress({
      kind: "suite_started",
      runId: "run-1",
      scenarioTotal: 3,
    });
    state.handleProgress({
      kind: "scenario_started",
      runId: "run-1",
      scenarioId: "smoke",
      scenarioIndex: 1,
      scenarioName: "Smoke",
      scenarioTotal: 3,
    });
    state.handleProgress({
      kind: "scenario_finished",
      runId: "run-1",
      scenarioId: "smoke",
      scenarioIndex: 1,
      scenarioName: "Smoke",
      scenarioTotal: 3,
      passed: true,
      overallScore: 0.8,
    });
    state.handleProgress({
      kind: "scenario_error",
      runId: "run-1",
      scenarioId: "smoke#2",
      scenarioIndex: 2,
      scenarioName: "Smoke",
      scenarioTotal: 3,
      error: new Error("boom"),
    });

    const snapshot = state.snapshot();

    expect(snapshot.total).toBe(3);
    expect(snapshot.passed).toBe(1);
    expect(snapshot.errored).toBe(1);
    expect(snapshot.done).toBe(2);
    expect(snapshot.running).toBe(0);
    expect(snapshot.scenarios[2]?.status).toBe("pending");
  });

  test("hydrates details and averages from the database while preserving repeat display ids", () => {
    const seeded = seedDashboardRun();
    const state = new LiveDashboardState(seeded.dbUrl);
    state.primeScenarios([
      { ordinal: 0, displayId: "smoke", scenarioName: "Smoke" },
      { ordinal: 1, displayId: "smoke#2", scenarioName: "Smoke" },
    ]);
    state.handleProgress({
      kind: "suite_started",
      runId: seeded.runId,
      scenarioTotal: 2,
    });
    state.handleProgress({
      kind: "scenario_finished",
      runId: seeded.runId,
      scenarioId: "smoke",
      scenarioIndex: 1,
      scenarioName: "Smoke",
      scenarioTotal: 2,
      passed: true,
      overallScore: 0.9,
    });
    state.handleProgress({
      kind: "scenario_finished",
      runId: seeded.runId,
      scenarioId: "smoke#2",
      scenarioIndex: 2,
      scenarioName: "Smoke",
      scenarioTotal: 2,
      passed: false,
      overallScore: 0.4,
    });

    const snapshot = state.snapshot();

    expect(snapshot.details[1]?.user_id).toBe("user-2");
    expect(snapshot.scenarios[1]?.scenario_id).toBe("smoke#2");
    expect(snapshot.averages).toHaveLength(1);
    expect(snapshot.averages[0]).toMatchObject({
      base_id: "smoke",
      n: 2,
      pass_count: 1,
      fail_count: 1,
      failure_modes: { fabrication: 1 },
      ordinals: [0, 1],
    });
    expect(snapshot.averages[0]?.judge_notes).toEqual([
      "Strong memory recall.",
      "Missed the stored fact.",
    ]);
  });

  test("returns undefined when the dashboard build is missing", () => {
    const handle = startDashboardServer({
      distDir: join(makeTempDir("dashboard-missing"), "missing"),
    });

    expect(handle).toBeUndefined();
  });

  test("serves index.html and /api/state over Bun.serve", async () => {
    const distDir = join(makeTempDir("dashboard-dist"), "dist");
    mkdirSync(distDir, { recursive: true });
    writeFileSync(
      join(distDir, "index.html"),
      "<!doctype html><html><body>dashboard ok</body></html>",
      "utf8",
    );

    const handle = startDashboardServer({ distDir });
    if (!handle) {
      throw new Error("Expected dashboard server to start.");
    }
    servers.push(handle);
    handle.state.primeScenarios([
      { ordinal: 0, displayId: "smoke", scenarioName: "Smoke" },
    ]);
    handle.state.handleProgress({
      kind: "suite_started",
      runId: "run-1",
      scenarioTotal: 1,
    });

    const [htmlResponse, stateResponse] = await Promise.all([
      fetch(handle.url),
      fetch(`${handle.url}/api/state`),
    ]);
    const html = await htmlResponse.text();
    const state = (await stateResponse.json()) as {
      total: number;
      scenarios: Array<{ scenario_id: string }>;
    };

    expect(html).toContain("dashboard ok");
    expect(state.total).toBe(1);
    expect(state.scenarios[0]?.scenario_id).toBe("smoke");
  });
});

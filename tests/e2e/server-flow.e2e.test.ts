import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { type DashboardServerHandle, startDashboardServer } from "./support.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");

type Json = Record<string, unknown>;

async function fetchJson<T = Json>(
  url: string,
  init?: RequestInit,
): Promise<{ status: number; body: T }> {
  const response = await fetch(url, init);
  const text = await response.text();
  let body: T;
  try {
    body = (text ? JSON.parse(text) : {}) as T;
  } catch {
    throw new Error(
      `Expected JSON from ${url} (status ${response.status}); got: ${text.slice(0, 200)}`,
    );
  }
  return { status: response.status, body };
}

async function pollRunUntilTerminal(
  baseUrl: string,
  runId: string,
  timeoutMs: number,
): Promise<Json & { status: string }> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "unknown";
  while (Date.now() < deadline) {
    const { status, body } = await fetchJson<{
      run: Json & { status: string };
    }>(`${baseUrl}/api/runs/${runId}`);
    if (status === 200) {
      lastStatus = body.run.status;
      if (
        lastStatus === "completed" ||
        lastStatus === "failed" ||
        lastStatus === "cancelled"
      ) {
        return body.run;
      }
    }
    await Bun.sleep(150);
  }
  throw new Error(
    `Run ${runId} did not reach a terminal status within ${timeoutMs}ms (last status: ${lastStatus}).`,
  );
}

describe("dashboard server: default preset seeding", () => {
  let workspaceRoot: string;
  let dbPath: string;

  beforeAll(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "agentprobe-default-preset-"));
    dbPath = join(workspaceRoot, "runs.sqlite3");
  });

  test("seeds Pre Release Checks preset on first boot", async () => {
    const server = await startDashboardServer({ dataPath: "data", dbPath });
    try {
      const { status, body } = await fetchJson<{
        presets: Array<{ id: string; name: string; selection: unknown[] }>;
      }>(`${server.url}/api/presets`);
      expect(status).toBe(200);
      const preRelease = body.presets.find(
        (preset) => preset.name === "Pre Release Checks",
      );
      if (!preRelease) {
        throw new Error("Pre Release Checks preset was not seeded.");
      }
      expect(preRelease.id).toBeTruthy();
      expect(Array.isArray(preRelease.selection)).toBe(true);
      expect(preRelease.selection.length).toBe(14);
    } finally {
      await server.stop();
    }
  });

  test("re-booting against the same DB is idempotent", async () => {
    const server = await startDashboardServer({ dataPath: "data", dbPath });
    try {
      const { body } = await fetchJson<{
        presets: Array<{ id: string; name: string }>;
      }>(`${server.url}/api/presets`);
      const occurrences = body.presets.filter(
        (preset) => preset.name === "Pre Release Checks",
      );
      expect(occurrences.length).toBe(1);
    } finally {
      await server.stop();
    }
  });
});

describe("dashboard server: create preset, run, view results", () => {
  let workspaceRoot: string;
  let dbPath: string;
  let server: DashboardServerHandle;
  let presetId: string;
  let runId: string;

  beforeAll(async () => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "agentprobe-server-flow-"));
    dbPath = join(workspaceRoot, "runs.sqlite3");
    const fixtureSuite = join(REPO_ROOT, "tests", "e2e", "fixtures", "suite");

    server = await startDashboardServer({
      dataPath: fixtureSuite,
      dbPath,
      extraEnv: {
        OPEN_ROUTER_API_KEY: "e2e-openrouter-key",
        AUTOGPT_BACKEND_URL: "http://127.0.0.1:9",
        AUTOGPT_FRONTEND_URL: "http://127.0.0.1:9",
      },
    });
  });

  afterAll(async () => {
    if (server) {
      await server.stop();
    }
  });

  test("creates a preset (dry_run=true) via POST /api/presets", async () => {
    const requestBody = {
      name: "E2E Server Flow",
      description: "Created by tests/e2e/server-flow.e2e.test.ts",
      endpoint: "endpoints.yaml",
      personas: "personas.yaml",
      rubric: "rubric.yaml",
      selection: [
        { file: "scenarios.yaml", id: "refund-smoke" },
        { file: "scenarios.yaml", id: "billing-followup" },
      ],
      parallel: { enabled: false, limit: null },
      repeat: 1,
      dry_run: true,
    };

    const { status, body } = await fetchJson<{
      preset: {
        id: string;
        name: string;
        dry_run: boolean;
        selection: unknown[];
      };
    }>(`${server.url}/api/presets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestBody),
    });

    expect(status).toBe(201);
    expect(body.preset.name).toBe("E2E Server Flow");
    expect(body.preset.dry_run).toBe(true);
    expect(body.preset.selection.length).toBe(2);
    expect(body.preset.id).toBeTruthy();
    presetId = body.preset.id;
  });

  test("the new preset appears in GET /api/presets", async () => {
    const { status, body } = await fetchJson<{
      presets: Array<{ id: string; name: string }>;
    }>(`${server.url}/api/presets`);
    expect(status).toBe(200);
    const match = body.presets.find((preset) => preset.id === presetId);
    if (!match) {
      throw new Error(`Created preset ${presetId} not found in list.`);
    }
    expect(match.name).toBe("E2E Server Flow");
  });

  test("starts a dry-run from the preset via POST /api/presets/:id/runs", async () => {
    const { status, body } = await fetchJson<{
      run_id: string;
      status: string;
    }>(`${server.url}/api/presets/${presetId}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(status).toBe(202);
    expect(body.run_id).toBeTruthy();
    expect(typeof body.status).toBe("string");
    runId = body.run_id;
  });

  test("the dry-run completes and persists both scenarios in stable ordinal order", async () => {
    const run = (await pollRunUntilTerminal(server.url, runId, 20_000)) as {
      runId: string;
      status: string;
      passed: boolean;
      scenarios: Array<{ ordinal: number; scenarioId: string }>;
    };

    expect(run.runId).toBe(runId);
    expect(run.status).toBe("completed");
    expect(run.passed).toBe(true);
    expect(run.scenarios.length).toBe(2);
    expect(run.scenarios.map((s) => s.ordinal)).toEqual([0, 1]);

    const ids = run.scenarios.map((s) => s.scenarioId);
    expect(ids).toContain("refund-smoke");
    expect(ids).toContain("billing-followup");
  });

  test("the run is reachable via GET /api/runs filtered by preset_id", async () => {
    const { status, body } = await fetchJson<{
      runs: Array<{ runId: string; presetId: string | null }>;
    }>(`${server.url}/api/runs?preset_id=${presetId}`);
    expect(status).toBe(200);
    expect(body.runs.some((run) => run.runId === runId)).toBe(true);
    for (const run of body.runs) {
      expect(run.presetId).toBe(presetId);
    }
  });

  test("GET /api/runs/:runId/scenarios/:ordinal returns scenario detail with the initial prompt", async () => {
    const { status, body } = await fetchJson<{
      run: { runId: string; status: string };
      scenario: {
        ordinal: number;
        scenarioId: string;
        passed: boolean | null;
        overallScore: number | null;
        turns: Array<{
          turn_index: number;
          role: string;
          content: string | null;
        }>;
        judgeDimensionScores: Array<{
          dimension_id: string;
          raw_score: number;
          reasoning: string;
        }>;
      };
    }>(`${server.url}/api/runs/${runId}/scenarios/0`);
    expect(status).toBe(200);
    expect(body.run.runId).toBe(runId);
    expect(body.run.status).toBe("completed");
    expect(body.scenario.ordinal).toBe(0);
    expect(["refund-smoke", "billing-followup"]).toContain(
      body.scenario.scenarioId,
    );
    expect(body.scenario.passed).toBe(true);

    expect(Array.isArray(body.scenario.turns)).toBe(true);
    expect(body.scenario.turns.length).toBe(1);
    const firstTurn = body.scenario.turns[0];
    if (!firstTurn) {
      throw new Error(
        "Expected the dry-run scenario to record an initial turn.",
      );
    }
    expect(firstTurn.role).toBe("user");
    expect(firstTurn.turn_index).toBe(0);
    expect(typeof firstTurn.content).toBe("string");
    expect((firstTurn.content ?? "").length).toBeGreaterThan(0);

    expect(Array.isArray(body.scenario.judgeDimensionScores)).toBe(true);
    expect(body.scenario.judgeDimensionScores.length).toBeGreaterThan(0);
    const dimension = body.scenario.judgeDimensionScores[0];
    if (!dimension) {
      throw new Error(
        "Expected the dry-run scenario to record a judge dimension score.",
      );
    }
    expect(dimension.dimension_id).toBe("task_completion");
    expect(dimension.raw_score).toBeGreaterThan(0);
    expect(dimension.reasoning).toContain("Dry run");
  });

  test("GET /api/runs/:runId/scenarios/:ordinal returns 404 for an unknown ordinal", async () => {
    const response = await fetch(
      `${server.url}/api/runs/${runId}/scenarios/99`,
    );
    expect(response.status).toBe(404);
    const body = (await response.json()) as {
      error?: { type?: string; message?: string };
    };
    expect(body.error?.type).toBe("NotFound");
    expect(body.error?.message).toContain("99");
  });
});

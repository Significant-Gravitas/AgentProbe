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

type SuitesResponse = {
  suites: Array<{ id: string }>;
};

type ScenariosResponse = {
  scenarios: Array<{ id: string }>;
};

type RunsResponse = {
  total: number;
  runs: Array<{ runId: string }>;
};

type RunResponse = {
  run: { scenarios: Array<{ scenarioId: string }> };
};

type ScenarioResponse = {
  scenario: { scenarioName: string };
};

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
  writeFileSync(
    join(data, "personas.yaml"),
    [
      "personas:",
      "  - id: analyst",
      "    name: Analyst",
      "    demographics:",
      "      role: operator",
      "      tech_literacy: high",
      "      domain_expertise: intermediate",
      "      language_style: terse",
      "    personality:",
      "      patience: 3",
      "      assertiveness: 3",
      "      detail_orientation: 4",
      "      cooperativeness: 4",
      "      emotional_intensity: 1",
      "    behavior:",
      "      opening_style: Direct.",
      "      follow_up_style: Concise.",
      "      escalation_triggers: []",
      "      topic_drift: none",
      "      clarification_compliance: high",
      "    system_prompt: You are direct.",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(data, "rubric.yaml"),
    [
      "judge:",
      "  provider: openai",
      "  model: anthropic/claude-opus-4.6",
      "  temperature: 0",
      "  max_tokens: 500",
      "rubrics:",
      "  - id: support",
      "    name: Support",
      "    pass_threshold: 0.7",
      '    meta_prompt: "Judge the answer."',
      "    dimensions:",
      "      - id: task_completion",
      "        name: Task Completion",
      "        weight: 1",
      "        scale:",
      "          type: likert",
      "          points: 5",
      '        judge_prompt: "Score task completion."',
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(data, "scenarios.yaml"),
    [
      "scenarios:",
      "  - id: smoke",
      "    name: Smoke",
      "    tags: [smoke]",
      "    priority: high",
      "    persona: analyst",
      "    rubric: support",
      "    turns:",
      "      - role: user",
      "        content: Say hello.",
      "    expectations:",
      "      expected_behavior: Greets the user.",
      "",
    ].join("\n"),
    "utf8",
  );
  return data;
}

function seedRun(dbPath: string): string {
  const dbUrl = `sqlite:///${dbPath}`;
  const runId = "run-readonly";
  initDb(dbUrl);

  const database = new Database(dbPath);
  try {
    database
      .query(
        `insert into runs (
          id, status, passed, exit_code, preset, suite_fingerprint, started_at,
          updated_at, completed_at, scenario_total, scenario_passed_count,
          scenario_failed_count, scenario_errored_count
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        runId,
        "completed",
        1,
        0,
        "smoke-preset",
        "suite-fingerprint",
        "2026-04-17T10:00:00.000Z",
        "2026-04-17T10:00:10.000Z",
        "2026-04-17T10:00:10.000Z",
        1,
        1,
        0,
        0,
      );
    database
      .query(
        `insert into scenario_runs (
          run_id, ordinal, scenario_id, scenario_name, persona_id, rubric_id,
          user_id, status, passed, overall_score, pass_threshold,
          judge_provider, judge_model, judge_temperature, judge_max_tokens,
          overall_notes, judge_output_json, turn_count, assistant_turn_count,
          tool_call_count, checkpoint_count, started_at, updated_at, completed_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        runId,
        0,
        "smoke",
        "Smoke",
        "analyst",
        "support",
        "user-1",
        "completed",
        1,
        0.9,
        0.7,
        "openai",
        "anthropic/claude-opus-4.6",
        0,
        500,
        "Clear response.",
        JSON.stringify({ failure_mode_detected: null }),
        2,
        1,
        0,
        0,
        "2026-04-17T10:00:00.000Z",
        "2026-04-17T10:00:10.000Z",
        "2026-04-17T10:00:10.000Z",
      );
    database
      .query(
        `insert into turns (
          scenario_run_id, turn_index, role, source, content, created_at
        ) values (?, ?, ?, ?, ?, ?)`,
      )
      .run(1, 0, "user", "user_exact", "Say hello.", "2026-04-17T10:00:01Z");
    database
      .query(
        `insert into turns (
          scenario_run_id, turn_index, role, source, content, created_at
        ) values (?, ?, ?, ?, ?, ?)`,
      )
      .run(1, 1, "assistant", "target", "Hello.", "2026-04-17T10:00:02Z");
    database
      .query(
        `insert into judge_dimension_scores (
          scenario_run_id, dimension_id, dimension_name, weight, scale_type,
          scale_points, raw_score, normalized_score, reasoning, evidence_json,
          created_at
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
        "The greeting was direct.",
        JSON.stringify(["Hello."]),
        "2026-04-17T10:00:03Z",
      );
  } finally {
    database.close();
  }
  return runId;
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  expect(response.ok).toBe(true);
  return (await response.json()) as T;
}

describe("read-only AgentProbe server", () => {
  const servers: StartedServer[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await server.stop();
    }
  });

  async function start(
    options: { token?: string; env?: Record<string, string | undefined> } = {},
  ) {
    const root = makeTempDir("server-integration");
    const data = writeSuite(root);
    const dbPath = join(root, "runs.sqlite3");
    const runId = seedRun(dbPath);
    const args = [
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--data",
      data,
      "--db",
      dbPath,
    ];
    if (options.token) {
      args.push("--token", options.token);
    }
    const server = await startAgentProbeServer(
      buildServerConfig({ args, env: options.env ?? {} }),
    );
    servers.push(server);
    return { server, runId };
  }

  test("serves health, suites, runs, reports, static dashboard, and historical SSE", async () => {
    const { server, runId } = await start();

    const health = await json<{ status: string }>(`${server.url}/healthz`);
    expect(health.status).toBe("ok");

    const ready = await json<{ status: string }>(`${server.url}/readyz`);
    expect(ready.status).toBe("ready");

    const suites = await json<SuitesResponse>(`${server.url}/api/suites`);
    expect(suites.suites.some((suite) => suite.id === "scenarios")).toBe(true);

    const scenarios = await json<ScenariosResponse>(
      `${server.url}/api/scenarios`,
    );
    expect(scenarios.scenarios[0]?.id).toBe("smoke");

    const runs = await json<RunsResponse>(`${server.url}/api/runs`);
    expect(runs.total).toBe(1);
    expect(runs.runs[0]?.runId).toBe(runId);

    const run = await json<RunResponse>(`${server.url}/api/runs/${runId}`);
    expect(run.run.scenarios[0]?.scenarioId).toBe("smoke");

    const scenario = await json<ScenarioResponse>(
      `${server.url}/api/runs/${runId}/scenarios/0`,
    );
    expect(scenario.scenario.scenarioName).toBe("Smoke");

    const report = await fetch(`${server.url}/api/runs/${runId}/report.html`);
    expect(report.status).toBe(200);
    expect(report.headers.get("content-type")).toContain("text/html");

    const dashboard = await fetch(`${server.url}/`);
    expect(dashboard.status).toBe(200);
    expect(dashboard.headers.get("content-type")).toContain("text/html");

    const events = await fetch(`${server.url}/api/runs/${runId}/events`);
    expect(events.status).toBe(200);
    expect(events.headers.get("content-type")).toContain("text/event-stream");
    const text = await events.text();
    expect(text).toContain("event: snapshot");
    expect(text).toContain(`"run_id":"${runId}"`);
  });

  test("protects API routes with bearer auth while health and static stay public", async () => {
    const { server } = await start({ token: "server-token" });

    expect((await fetch(`${server.url}/healthz`)).status).toBe(200);
    expect((await fetch(`${server.url}/`)).status).toBe(200);

    const denied = await fetch(`${server.url}/api/runs`);
    expect(denied.status).toBe(401);
    const body = (await denied.json()) as { error: { code: string } };
    expect(body.error.code).toBe("Unauthorized");

    const allowed = await fetch(`${server.url}/api/runs`, {
      headers: { authorization: "Bearer server-token" },
    });
    expect(allowed.status).toBe(200);
  });

  test("allows same-origin API CORS by default and rejects other preflights", async () => {
    const { server } = await start();

    const allowed = await fetch(`${server.url}/api/runs`, {
      method: "OPTIONS",
      headers: {
        origin: server.url,
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization, content-type",
      },
    });
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe(server.url);
    expect(allowed.headers.get("access-control-allow-methods")).toContain(
      "POST",
    );
    expect(allowed.headers.get("access-control-allow-headers")).toBe(
      "authorization, content-type",
    );
    expect(allowed.headers.get("access-control-allow-credentials")).toBe(
      "true",
    );
    expect(allowed.headers.get("access-control-max-age")).toBe("600");

    const api = await fetch(`${server.url}/api/runs`, {
      headers: { origin: server.url },
    });
    expect(api.status).toBe(200);
    expect(api.headers.get("access-control-allow-origin")).toBe(server.url);

    const rejected = await fetch(`${server.url}/api/runs`, {
      method: "OPTIONS",
      headers: {
        origin: "https://dashboard.example",
        "access-control-request-method": "POST",
      },
    });
    expect(rejected.status).toBe(403);
    expect(rejected.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("allows configured cross-origin API CORS and rejects unlisted origins", async () => {
    const dashboardOrigin = "https://dashboard.example";
    const { server } = await start({
      env: { AGENTPROBE_SERVER_CORS_ORIGINS: dashboardOrigin },
    });

    const allowed = await fetch(`${server.url}/api/runs`, {
      method: "OPTIONS",
      headers: {
        origin: dashboardOrigin,
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization, content-type",
      },
    });
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe(
      dashboardOrigin,
    );
    expect(allowed.headers.get("access-control-allow-credentials")).toBe(
      "true",
    );

    const api = await fetch(`${server.url}/api/runs`, {
      headers: { origin: dashboardOrigin },
    });
    expect(api.status).toBe(200);
    expect(api.headers.get("access-control-allow-origin")).toBe(
      dashboardOrigin,
    );

    const rejected = await fetch(`${server.url}/api/runs`, {
      method: "OPTIONS",
      headers: {
        origin: "https://evil.example",
        "access-control-request-method": "POST",
      },
    });
    expect(rejected.status).toBe(403);
    expect(rejected.headers.get("access-control-allow-origin")).toBeNull();
  });
});

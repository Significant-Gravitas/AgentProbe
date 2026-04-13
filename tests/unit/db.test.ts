import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runSuite } from "../../src/domains/evaluation/run-suite.ts";
import {
  DEFAULT_DB_FILENAME,
  getRun,
  initDb,
  latestRunForSuite,
  listRuns,
  SqliteRunRecorder,
} from "../../src/providers/persistence/sqlite-run-history.ts";
import type { Endpoints } from "../../src/shared/types/contracts.ts";
import {
  AgentProbeConfigError,
  AgentProbeRuntimeError,
} from "../../src/shared/utils/errors.ts";
import {
  adapterReply,
  asResponsesClient,
  buildPersonaStep,
  buildScore,
  FailingAdapter,
  FakeAdapter,
  FakeResponsesClient,
  makeTempDir,
  toolCall,
} from "./support.ts";

function dbUrlFor(root: string): string {
  return `sqlite:///${join(root, DEFAULT_DB_FILENAME)}`;
}

function writeSuiteFiles(root: string): {
  endpoint: string;
  scenarios: string;
  personas: string;
  rubric: string;
} {
  const endpoint = join(root, "endpoint.yaml");
  const scenarios = join(root, "scenarios.yaml");
  const personas = join(root, "personas.yaml");
  const rubric = join(root, "rubric.yaml");
  mkdirSync(root, { recursive: true });

  writeFileSync(
    endpoint,
    [
      "transport: http",
      "connection:",
      "  base_url: http://example.test",
      "auth:",
      "  type: bearer_token",
      "  token: secret-token",
      "request:",
      "  method: POST",
      '  url: "{{ base_url }}/chat"',
      "  body_template: |",
      '    {"message": "{{ last_message.content }}", "session_token": "session-secret"}',
      "response:",
      "  format: text",
      '  content_path: "$"',
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    personas,
    [
      "personas:",
      "  - id: business-traveler",
      "    name: Business Traveler",
      "    demographics:",
      "      role: business customer",
      "      tech_literacy: high",
      "      domain_expertise: intermediate",
      "      language_style: terse",
      "    personality:",
      "      patience: 2",
      "      assertiveness: 4",
      "      detail_orientation: 5",
      "      cooperativeness: 4",
      "      emotional_intensity: 2",
      "    behavior:",
      "      opening_style: Be direct.",
      "      follow_up_style: Answer follow-up questions directly.",
      "      escalation_triggers: []",
      "      topic_drift: none",
      "      clarification_compliance: high",
      "    system_prompt: You are a direct business traveler.",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    rubric,
    [
      "judge:",
      "  provider: openai",
      "  model: anthropic/claude-opus-4.6",
      "  temperature: 0.0",
      "  max_tokens: 500",
      "rubrics:",
      "  - id: customer-support",
      "    name: Customer Support",
      "    pass_threshold: 0.7",
      '    meta_prompt: "Judge behavior: {{ expectations.expected_behavior }}"',
      "    dimensions:",
      "      - id: task_completion",
      "        name: Task Completion",
      "        weight: 1.0",
      "        scale:",
      "          type: likert",
      "          points: 5",
      "          labels:",
      "            1: bad",
      "            5: good",
      '        judge_prompt: "Booking reference: {{ booking_id }}"',
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    scenarios,
    [
      "defaults:",
      "  max_turns: 1",
      "scenarios:",
      "  - id: smoke-scenario",
      "    name: Smoke",
      "    tags: [smoke]",
      "    priority: high",
      "    persona: business-traveler",
      "    rubric: customer-support",
      "    context:",
      "      system_prompt: You are a travel assistant.",
      "      injected_data:",
      "        booking_id: FLT-29481",
      "    turns:",
      "      - role: user",
      "        content: Rebook {{ booking_id }}.",
      "      - role: checkpoint",
      "        assert:",
      "          - tool_called: lookup_booking",
      "            response_mentions: FLT-29481",
      "    expectations:",
      "      expected_behavior: Help the user quickly.",
      "      expected_outcome: resolved",
      "",
    ].join("\n"),
    "utf8",
  );

  return { endpoint, scenarios, personas, rubric };
}

function redactedReply() {
  return adapterReply("I can move FLT-29481 to an 11:15 AM arrival.", {
    toolCalls: [
      toolCall(
        "lookup_booking",
        { booking_id: "FLT-29481" },
        { order: 1, raw: { api_key: "tool-secret" } },
      ),
    ],
    rawExchange: {
      request: {
        headers: {
          Authorization: "Bearer secret-token",
          "X-Trace": "trace-1",
        },
        json_body: {
          session_token: "session-secret",
          message: "Rebook FLT-29481.",
        },
      },
      response: {
        headers: {
          "Set-Cookie": "session=session-secret",
        },
        body: {
          token: "response-secret",
          message: "I can move FLT-29481 to an 11:15 AM arrival.",
        },
      },
    },
    latencyMs: 12.5,
    usage: { input_tokens: 11, output_tokens: 17 },
  });
}

describe("sqlite recorder", () => {
  test("initDb creates tables and is idempotent", () => {
    const root = makeTempDir("db-init");
    const dbPath = join(root, DEFAULT_DB_FILENAME);
    initDb(`sqlite:///${dbPath}`);
    initDb(`sqlite:///${dbPath}`);

    const database = new Database(dbPath);
    try {
      const tableNames = new Set(
        (
          database
            .query("select name from sqlite_master where type = 'table'")
            .all() as Array<{ name: string }>
        ).map((row) => row.name),
      );
      for (const name of [
        "meta",
        "runs",
        "scenario_runs",
        "turns",
        "target_events",
        "tool_calls",
        "checkpoints",
        "judge_dimension_scores",
      ]) {
        expect(tableNames.has(name)).toBe(true);
      }
      expect(
        database.query("select schema_version from meta where id = 1").get(),
      ).toEqual({ schema_version: 2 });
    } finally {
      database.close();
    }
  });

  test("persists full traces, redaction, source labeling, and query helpers", async () => {
    const root = makeTempDir("db-success");
    const paths = writeSuiteFiles(root);
    const recorder = new SqliteRunRecorder(dbUrlFor(root));
    const client = new FakeResponsesClient([
      buildPersonaStep("continue", "Rebook FLT-29481."),
      buildPersonaStep("completed"),
      buildScore(),
    ]);

    const result = await runSuite({
      ...paths,
      client: asResponsesClient(client) as never,
      recorder,
      adapterFactory: (_endpoint: Endpoints) =>
        new FakeAdapter([redactedReply()]),
    });

    const persisted = getRun(result.runId ?? "", { dbUrl: dbUrlFor(root) });
    expect(persisted).not.toBeUndefined();
    expect(result.passed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(persisted?.runId).toBe(result.runId ?? undefined);
    expect(persisted?.status).toBe("completed");
    expect(result.results[0]?.userId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(persisted?.aggregateCounts).toEqual({
      scenarioTotal: 1,
      scenarioPassedCount: 1,
      scenarioFailedCount: 0,
      scenarioErroredCount: 0,
    });

    const scenario = persisted?.scenarios[0];
    expect(scenario).toBeDefined();
    if (!scenario) {
      throw new Error("Expected a persisted scenario.");
    }
    expect(scenario.status).toBe("completed");
    expect(scenario.passed).toBe(true);
    expect(scenario.userId).toBe(result.results[0]?.userId ?? null);
    expect(scenario.counts).toEqual({
      turnCount: 3,
      assistantTurnCount: 1,
      toolCallCount: 1,
      checkpointCount: 1,
    });
    expect(scenario.turns).toHaveLength(3);
    expect(scenario.turns[1]?.source).toBe("user_guided");
    expect(scenario.targetEvents).toHaveLength(1);
    expect(scenario.toolCalls).toHaveLength(1);
    expect(scenario.checkpoints).toHaveLength(1);
    expect(scenario.judgeDimensionScores).toHaveLength(1);

    expect(
      listRuns({ dbUrl: dbUrlFor(root) }).map((item) => item.runId),
    ).toEqual([result.runId ?? ""]);

    const latest = latestRunForSuite(persisted?.suiteFingerprint ?? "", {
      dbUrl: dbUrlFor(root),
    });
    expect(latest?.runId).toBe(result.runId ?? undefined);

    expect(persisted?.endpointSnapshot?.auth).toEqual({
      type: "bearer_token",
      token: "[REDACTED]",
      command: [],
    });
    const rawExchange = scenario.targetEvents[0]?.raw_exchange as Record<
      string,
      unknown
    >;
    expect(
      (
        (rawExchange.request as Record<string, unknown>).headers as Record<
          string,
          string
        >
      ).Authorization,
    ).toBe("[REDACTED]");
    expect(
      (
        (rawExchange.request as Record<string, unknown>).json_body as Record<
          string,
          string
        >
      ).session_token,
    ).toBe("[REDACTED]");
    expect(
      (
        (rawExchange.response as Record<string, unknown>).headers as Record<
          string,
          string
        >
      )["Set-Cookie"],
    ).toBe("[REDACTED]");
    expect(
      (
        (rawExchange.response as Record<string, unknown>).body as Record<
          string,
          string
        >
      ).token,
    ).toBe("[REDACTED]");
    expect((scenario.toolCalls[0]?.raw as Record<string, string>).api_key).toBe(
      "[REDACTED]",
    );
  });

  test("distinguishes exact and guided user turns", async () => {
    const root = makeTempDir("db-sources");
    const paths = writeSuiteFiles(root);
    writeFileSync(
      paths.scenarios,
      [
        "defaults:",
        "  max_turns: 2",
        "scenarios:",
        "  - id: smoke-scenario",
        "    name: Smoke",
        "    tags: [smoke]",
        "    priority: high",
        "    persona: business-traveler",
        "    rubric: customer-support",
        "    context:",
        "      system_prompt: You are a travel assistant.",
        "      injected_data:",
        "        booking_id: FLT-29481",
        "    turns:",
        "      - role: user",
        "        content: Use booking {{ booking_id }} exactly.",
        "        use_exact_message: true",
        "      - role: user",
        "        content: Ask to arrive before noon.",
        "    expectations:",
        "      expected_behavior: Help the user quickly.",
        "      expected_outcome: resolved",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await runSuite({
      ...paths,
      recorder: new SqliteRunRecorder(dbUrlFor(root)),
      client: asResponsesClient(
        new FakeResponsesClient([
          buildPersonaStep("continue", "I need to land before noon."),
          buildPersonaStep("completed"),
          buildScore(),
        ]),
      ) as never,
      adapterFactory: (_endpoint: Endpoints) =>
        new FakeAdapter([
          adapterReply("What timing works?"),
          adapterReply("I found an 11:15 AM arrival."),
        ]),
    });

    const persisted = getRun(result.runId ?? "", { dbUrl: dbUrlFor(root) });
    const sources = persisted?.scenarios[0]?.turns
      .filter((turn) => turn.role === "user")
      .map((turn) => turn.source);
    expect(sources).toEqual(["user_exact", "user_guided"]);
  });

  test("persists config and runtime errors", async () => {
    const configRoot = makeTempDir("db-config-error");
    const configPaths = writeSuiteFiles(configRoot);
    const configRecorder = new SqliteRunRecorder(dbUrlFor(configRoot));
    await expect(
      runSuite({
        ...configPaths,
        scenarioId: "missing-scenario",
        client: asResponsesClient(
          new FakeResponsesClient([buildScore()]),
        ) as never,
        recorder: configRecorder,
      }),
    ).rejects.toThrow(AgentProbeConfigError);

    const configRun = listRuns({ dbUrl: dbUrlFor(configRoot) })[0];
    expect(configRun).toBeDefined();
    if (!configRun) {
      throw new Error("Expected a persisted config-error run.");
    }
    expect(configRun.status).toBe("config_error");
    expect(configRun.exitCode).toBe(2);
    expect(configRun.finalError).toEqual({
      type: "AgentProbeConfigError",
      message: "No scenarios matched the requested filters.",
    });

    const runtimeRoot = makeTempDir("db-runtime-error");
    const runtimePaths = writeSuiteFiles(runtimeRoot);
    const runtimeRecorder = new SqliteRunRecorder(dbUrlFor(runtimeRoot));
    await expect(
      runSuite({
        ...runtimePaths,
        client: asResponsesClient(
          new FakeResponsesClient([buildScore()]),
        ) as never,
        recorder: runtimeRecorder,
        adapterFactory: (_endpoint: Endpoints) =>
          new FailingAdapter("endpoint down"),
      }),
    ).rejects.toThrow(AgentProbeRuntimeError);

    const runtimeRun = listRuns({ dbUrl: dbUrlFor(runtimeRoot) })[0];
    expect(runtimeRun).toBeDefined();
    if (!runtimeRun) {
      throw new Error("Expected a persisted runtime-error run.");
    }
    expect(runtimeRun.status).toBe("runtime_error");
    expect(runtimeRun.exitCode).toBe(3);
    expect(runtimeRun.aggregateCounts).toEqual({
      scenarioTotal: 1,
      scenarioPassedCount: 0,
      scenarioFailedCount: 0,
      scenarioErroredCount: 1,
    });

    const persistedRuntime = getRun(runtimeRun.runId, {
      dbUrl: dbUrlFor(runtimeRoot),
    });
    expect(persistedRuntime?.scenarios[0]?.status).toBe("runtime_error");
    expect(persistedRuntime?.scenarios[0]?.error).toEqual({
      type: "AgentProbeRuntimeError",
      message: "endpoint down",
    });
  });

  test("normalizes naive timestamps when resolving latestRunForSuite cutoffs", () => {
    const root = makeTempDir("db-cutoff");
    const dbUrl = dbUrlFor(root);
    const dbPath = join(root, DEFAULT_DB_FILENAME);
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
          "run-older",
          "completed",
          1,
          0,
          "suite-1",
          "2026-04-10T10:00:00",
          "2026-04-10T10:05:00",
          "2026-04-10T10:05:00",
          0,
          0,
          0,
          0,
        );
      database
        .query(
          `insert into runs (
          id, status, passed, exit_code, suite_fingerprint, started_at, updated_at,
          completed_at, scenario_total, scenario_passed_count, scenario_failed_count,
          scenario_errored_count
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "run-newer",
          "completed",
          1,
          0,
          "suite-1",
          "2026-04-10T12:00:00",
          "2026-04-10T12:05:00",
          "2026-04-10T12:05:00",
          0,
          0,
          0,
          0,
        );
    } finally {
      database.close();
    }

    const latest = latestRunForSuite("suite-1", {
      dbUrl,
      beforeStartedAt: "2026-04-10T11:00:00Z",
    });

    expect(latest?.runId).toBe("run-older");
  });

  test("migrates pre-user_id scenario_runs schemas in place", () => {
    const root = makeTempDir("db-migration");
    const dbPath = join(root, DEFAULT_DB_FILENAME);
    const database = new Database(dbPath);
    try {
      database.exec(`
        create table meta (
          id integer primary key,
          schema_version integer not null,
          created_at text not null
        );
        insert into meta (id, schema_version, created_at) values (1, 1, '2026-04-10T10:00:00Z');

        create table runs (
          id text primary key,
          status text not null,
          passed integer,
          exit_code integer,
          filters_json text,
          selected_scenario_ids_json text,
          source_paths_json text,
          suite_fingerprint text,
          endpoint_config_hash text,
          scenarios_config_hash text,
          personas_config_hash text,
          rubric_config_hash text,
          transport text,
          preset text,
          endpoint_snapshot_json text,
          final_error_json text,
          scenario_total integer not null default 0,
          scenario_passed_count integer not null default 0,
          scenario_failed_count integer not null default 0,
          scenario_errored_count integer not null default 0,
          started_at text not null,
          updated_at text not null,
          completed_at text
        );

        create table scenario_runs (
          id integer primary key autoincrement,
          run_id text not null,
          ordinal integer not null default 0,
          scenario_id text not null,
          scenario_name text not null,
          persona_id text not null,
          rubric_id text not null,
          tags_json text,
          priority text,
          expectations_json text,
          scenario_snapshot_json text,
          persona_snapshot_json text,
          rubric_snapshot_json text,
          status text not null,
          passed integer,
          overall_score real,
          pass_threshold real,
          judge_provider text,
          judge_model text,
          judge_temperature real,
          judge_max_tokens integer,
          overall_notes text,
          judge_output_json text,
          turn_count integer not null default 0,
          assistant_turn_count integer not null default 0,
          tool_call_count integer not null default 0,
          checkpoint_count integer not null default 0,
          error_json text,
          started_at text not null,
          updated_at text not null,
          completed_at text
        );
      `);
    } finally {
      database.close();
    }

    initDb(`sqlite:///${dbPath}`);

    const migrated = new Database(dbPath);
    try {
      const columns = (
        migrated.query("pragma table_info(scenario_runs)").all() as Array<{
          name: string;
        }>
      ).map((row) => row.name);
      expect(columns.includes("user_id")).toBe(true);
      expect(
        migrated.query("select schema_version from meta where id = 1").get(),
      ).toEqual({ schema_version: 2 });
    } finally {
      migrated.close();
    }
  });
});

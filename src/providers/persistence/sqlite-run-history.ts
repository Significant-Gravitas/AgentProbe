import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type {
  AdapterReply,
  CheckpointAssertion,
  CheckpointResult,
  Endpoints,
  JsonValue,
  Persona,
  Rubric,
  RubricScore,
  RunRecord,
  RunResult,
  RunSummary,
  Scenario,
  ScenarioRunResult,
} from "../../shared/types/contracts.ts";
import {
  AgentProbeRuntimeError,
  errorPayload,
} from "../../shared/utils/errors.ts";

export const DEFAULT_DB_DIRNAME = ".agentprobe";
export const DEFAULT_DB_FILENAME = "runs.sqlite3";
export const SCHEMA_VERSION = 2;
const REDACTED_VALUE = "[REDACTED]";
const sensitiveExactKeys = new Set([
  "access_token",
  "api_key",
  "api-key",
  "authorization",
  "client_secret",
  "cookie",
  "header_value",
  "id_token",
  "password",
  "refresh_token",
  "secret",
  "session_token",
  "set-cookie",
  "token",
  "x-api-key",
]);
const sensitiveSuffixes = [
  "_token",
  "_secret",
  "_password",
  "_cookie",
  "_apikey",
  "_api_key",
];

function utcNow(): string {
  return new Date().toISOString();
}

function ensureDirectory(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

function encodeJson(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function decodeJson<T>(value: unknown): T | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function normalizeValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (value === undefined) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeValue(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([_key, item]) => item !== undefined)
        .map(([key, item]) => [key, normalizeValue(item)]),
    );
  }
  return String(value);
}

function hashValue(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(normalizeValue(value)))
    .digest("hex");
}

function shouldRedactKey(key: string): boolean {
  const lowered = key.toLowerCase();
  return (
    sensitiveExactKeys.has(lowered) ||
    sensitiveSuffixes.some((suffix) => lowered.endsWith(suffix))
  );
}

function redactValue(value: unknown, parentKey?: string): JsonValue {
  if (parentKey && shouldRedactKey(parentKey)) {
    return REDACTED_VALUE;
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value as JsonValue;
  }
  if (value === undefined) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, parentKey));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([_key, item]) => item !== undefined)
        .map(([key, item]) => [key, redactValue(item, key)]),
    );
  }
  return String(value);
}

function filtersPayload(options: {
  scenarioFilter?: string;
  tags?: string;
}): Record<string, JsonValue> {
  return {
    scenario_id: options.scenarioFilter ?? null,
    tags: options.tags ?? null,
  };
}

function sourcePathsPayload(options: {
  endpoint: string;
  scenarios: string;
  personas: string;
  rubric: string;
}): Record<string, string> {
  return {
    endpoint: resolve(options.endpoint),
    scenarios: resolve(options.scenarios),
    personas: resolve(options.personas),
    rubric: resolve(options.rubric),
  };
}

function runStatusForExitCode(exitCode: number): string {
  if (exitCode === 2) {
    return "config_error";
  }
  if (exitCode === 3) {
    return "runtime_error";
  }
  return "error";
}

function resolveDbPath(dbUrl?: string): string {
  if (!dbUrl) {
    const defaultPath = resolve(DEFAULT_DB_DIRNAME, DEFAULT_DB_FILENAME);
    ensureDirectory(defaultPath);
    return defaultPath;
  }
  if (!dbUrl.startsWith("sqlite:///")) {
    throw new AgentProbeRuntimeError(`Unsupported db url: ${dbUrl}`);
  }
  const path = dbUrl.slice("sqlite:///".length);
  ensureDirectory(path);
  return path;
}

function openDatabase(dbUrl?: string): Database {
  return new Database(resolveDbPath(dbUrl));
}

function tableColumns(database: Database, tableName: string): Set<string> {
  const rows = database
    .query(`pragma table_info(${tableName})`)
    .all() as Array<{ name?: string }>;
  return new Set(
    rows.flatMap((row) =>
      typeof row.name === "string" && row.name.trim() ? [row.name] : [],
    ),
  );
}

function ensureColumn(
  database: Database,
  tableName: string,
  columnName: string,
  definition: string,
): void {
  if (tableColumns(database, tableName).has(columnName)) {
    return;
  }
  database.exec(
    `alter table ${tableName} add column ${columnName} ${definition}`,
  );
}

function migrateDatabase(database: Database, currentVersion: number): void {
  let version = currentVersion;
  if (version < 2) {
    ensureColumn(database, "scenario_runs", "user_id", "text");
    database.query("update meta set schema_version = ? where id = 1").run(2);
    version = 2;
  }

  if (version !== SCHEMA_VERSION) {
    throw new AgentProbeRuntimeError(
      `Unsupported run-history schema version ${version}; expected ${SCHEMA_VERSION}.`,
    );
  }
}

function normalizeUtcTimestamp(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const normalized = /(?:[zZ]|[+-]\d{2}:\d{2})$/.test(trimmed)
    ? trimmed
    : `${trimmed}Z`;
  const timestamp = Date.parse(normalized);
  return Number.isNaN(timestamp) ? undefined : timestamp;
}

export function initDb(dbUrl?: string): void {
  const database = openDatabase(dbUrl);
  try {
    database.exec(`
      create table if not exists meta (
        id integer primary key,
        schema_version integer not null,
        created_at text not null
      );

      create table if not exists runs (
        id text primary key,
        status text not null,
        passed integer,
        exit_code integer,
        transport text,
        preset text,
        filters_json text,
        selected_scenario_ids_json text,
        suite_fingerprint text,
        source_paths_json text,
        endpoint_config_hash text,
        scenarios_config_hash text,
        personas_config_hash text,
        rubric_config_hash text,
        endpoint_snapshot_json text,
        scenario_total integer not null default 0,
        scenario_passed_count integer not null default 0,
        scenario_failed_count integer not null default 0,
        scenario_errored_count integer not null default 0,
        final_error_json text,
        started_at text not null,
        updated_at text not null,
        completed_at text
      );

      create table if not exists scenario_runs (
        id integer primary key autoincrement,
        run_id text not null,
        ordinal integer not null,
        scenario_id text not null,
        scenario_name text not null,
        persona_id text not null,
        rubric_id text not null,
        user_id text,
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

      create table if not exists turns (
        id integer primary key autoincrement,
        scenario_run_id integer not null,
        turn_index integer not null,
        role text not null,
        source text not null,
        content text,
        generator_model text,
        latency_ms real,
        usage_json text,
        created_at text not null
      );

      create table if not exists target_events (
        id integer primary key autoincrement,
        scenario_run_id integer not null,
        turn_index integer not null,
        exchange_index integer not null,
        raw_exchange_json text,
        latency_ms real,
        usage_json text,
        created_at text not null
      );

      create table if not exists tool_calls (
        id integer primary key autoincrement,
        scenario_run_id integer not null,
        turn_index integer not null,
        call_order integer,
        name text not null,
        args_json text,
        raw_json text,
        created_at text not null
      );

      create table if not exists checkpoints (
        id integer primary key autoincrement,
        scenario_run_id integer not null,
        checkpoint_index integer not null,
        preceding_turn_index integer,
        passed integer not null,
        failures_json text,
        assertions_json text,
        created_at text not null
      );

      create table if not exists judge_dimension_scores (
        id integer primary key autoincrement,
        scenario_run_id integer not null,
        dimension_id text not null,
        dimension_name text not null,
        weight real not null,
        scale_type text not null,
        scale_points real,
        raw_score real not null,
        normalized_score real not null,
        reasoning text not null,
        evidence_json text,
        created_at text not null
      );
    `);

    const meta = database
      .query("select schema_version from meta where id = 1")
      .get() as { schema_version?: number } | null;
    if (!meta) {
      database
        .query(
          "insert into meta (id, schema_version, created_at) values (1, ?, ?)",
        )
        .run(SCHEMA_VERSION, utcNow());
    } else if ((meta.schema_version ?? 0) < SCHEMA_VERSION) {
      migrateDatabase(database, meta.schema_version ?? 0);
    } else if (meta.schema_version !== SCHEMA_VERSION) {
      throw new AgentProbeRuntimeError(
        `Unsupported run-history schema version ${meta.schema_version}; expected ${SCHEMA_VERSION}.`,
      );
    }
  } finally {
    database.close();
  }
}

function refreshRunCounts(database: Database, runId: string): void {
  const rows = database
    .query(
      "select status, passed from scenario_runs where run_id = ? order by ordinal asc",
    )
    .all(runId) as Array<{ status: string; passed: number | null }>;
  const scenarioTotal = rows.length;
  const scenarioPassedCount = rows.filter(
    (row) => row.status === "completed" && row.passed === 1,
  ).length;
  const scenarioFailedCount = rows.filter(
    (row) => row.status === "completed" && row.passed === 0,
  ).length;
  const scenarioErroredCount = rows.filter((row) =>
    ["runtime_error", "error"].includes(row.status),
  ).length;

  database
    .query(
      `
        update runs
        set scenario_total = ?,
            scenario_passed_count = ?,
            scenario_failed_count = ?,
            scenario_errored_count = ?,
            updated_at = ?
        where id = ?
      `,
    )
    .run(
      scenarioTotal,
      scenarioPassedCount,
      scenarioFailedCount,
      scenarioErroredCount,
      utcNow(),
      runId,
    );
}

function scenarioStatusForError(error: Error): string {
  return error.name === "AgentProbeRuntimeError" ? "runtime_error" : "error";
}

function normalizedDimensionScore(
  rubric: Rubric,
  dimensionId: string,
  rawScore: number,
): number {
  const dimension = rubric.dimensions.find((item) => item.id === dimensionId);
  const scalePoints = dimension?.scale.points ?? 1;
  return rawScore / scalePoints;
}

export class SqliteRunRecorder {
  readonly dbUrl: string;
  private readonly database: Database;
  runId?: string;

  constructor(dbUrl?: string) {
    this.dbUrl = `sqlite:///${resolveDbPath(dbUrl)}`;
    initDb(this.dbUrl);
    this.database = openDatabase(this.dbUrl);
  }

  private requireRunId(): string {
    if (!this.runId) {
      throw new AgentProbeRuntimeError("Run recorder has not been started.");
    }
    return this.runId;
  }

  recordRunStarted(options: {
    endpoint: string;
    scenarios: string;
    personas: string;
    rubric: string;
    scenarioFilter?: string;
    tags?: string;
  }): string {
    const runId = randomUUID().replaceAll("-", "");
    const now = utcNow();
    this.database
      .query(
        `
          insert into runs (
            id, status, passed, exit_code, filters_json, selected_scenario_ids_json,
            source_paths_json, scenario_total, scenario_passed_count,
            scenario_failed_count, scenario_errored_count, started_at, updated_at
          ) values (?, 'running', null, null, ?, ?, ?, 0, 0, 0, 0, ?, ?)
        `,
      )
      .run(
        runId,
        encodeJson(
          filtersPayload({
            scenarioFilter: options.scenarioFilter,
            tags: options.tags,
          }),
        ),
        encodeJson([]),
        encodeJson(
          sourcePathsPayload({
            endpoint: options.endpoint,
            scenarios: options.scenarios,
            personas: options.personas,
            rubric: options.rubric,
          }),
        ),
        now,
        now,
      );
    this.runId = runId;
    return runId;
  }

  recordRunConfiguration(options: {
    endpointConfig: Endpoints;
    scenarioCollection: { scenarios: Scenario[] };
    personaCollection: { personas: Persona[] };
    rubricCollection: { rubrics: Rubric[] };
    selectedScenarios: Scenario[];
    scenarioFilter?: string;
    tags?: string;
  }): void {
    const redactedEndpointSnapshot = redactValue(options.endpointConfig);
    const endpointHash = hashValue(redactedEndpointSnapshot);
    const scenariosHash = hashValue(options.scenarioCollection);
    const personasHash = hashValue(options.personaCollection);
    const rubricHash = hashValue(options.rubricCollection);
    const selectedScenarioIds = options.selectedScenarios.map(
      (item) => item.id,
    );
    const suiteFingerprint = hashValue({
      endpoint_config_hash: endpointHash,
      scenarios_config_hash: scenariosHash,
      personas_config_hash: personasHash,
      rubric_config_hash: rubricHash,
      filters: filtersPayload({
        scenarioFilter: options.scenarioFilter,
        tags: options.tags,
      }),
      selected_scenario_ids: selectedScenarioIds,
    });

    this.database
      .query(
        `
          update runs
          set transport = ?,
              preset = ?,
              selected_scenario_ids_json = ?,
              suite_fingerprint = ?,
              endpoint_config_hash = ?,
              scenarios_config_hash = ?,
              personas_config_hash = ?,
              rubric_config_hash = ?,
              endpoint_snapshot_json = ?,
              scenario_total = ?,
              updated_at = ?
          where id = ?
        `,
      )
      .run(
        options.endpointConfig.transport ?? null,
        options.endpointConfig.preset ?? null,
        encodeJson(selectedScenarioIds),
        suiteFingerprint,
        endpointHash,
        scenariosHash,
        personasHash,
        rubricHash,
        encodeJson(redactedEndpointSnapshot),
        selectedScenarioIds.length,
        utcNow(),
        this.requireRunId(),
      );
  }

  recordRunFinished(result: RunResult): void {
    refreshRunCounts(this.database, this.requireRunId());
    this.database
      .query(
        `
          update runs
          set status = 'completed',
              passed = ?,
              exit_code = ?,
              completed_at = ?,
              updated_at = ?
          where id = ?
        `,
      )
      .run(
        result.passed ? 1 : 0,
        result.exitCode,
        utcNow(),
        utcNow(),
        this.requireRunId(),
      );
  }

  recordRunError(error: Error, options: { exitCode: number }): void {
    refreshRunCounts(this.database, this.requireRunId());
    this.database
      .query(
        `
          update runs
          set status = ?,
              passed = 0,
              exit_code = ?,
              final_error_json = ?,
              completed_at = ?,
              updated_at = ?
          where id = ?
        `,
      )
      .run(
        runStatusForExitCode(options.exitCode),
        options.exitCode,
        encodeJson(errorPayload(error)),
        utcNow(),
        utcNow(),
        this.requireRunId(),
      );
  }

  recordScenarioStarted(options: {
    scenario: Scenario;
    persona: Persona;
    rubric: Rubric;
    ordinal?: number;
    userId?: string;
  }): number {
    const now = utcNow();
    this.database
      .query(
        `
          insert into scenario_runs (
            run_id, ordinal, scenario_id, scenario_name, persona_id, rubric_id,
            user_id, tags_json, priority, expectations_json, scenario_snapshot_json,
            persona_snapshot_json, rubric_snapshot_json, status, pass_threshold,
            judge_provider, judge_model, judge_temperature, judge_max_tokens,
            turn_count, assistant_turn_count, tool_call_count, checkpoint_count,
            started_at, updated_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, 0, 0, 0, 0, ?, ?)
        `,
      )
      .run(
        this.requireRunId(),
        options.ordinal ?? 0,
        options.scenario.id,
        options.scenario.name,
        options.persona.id,
        options.rubric.id,
        options.userId ?? null,
        encodeJson(redactValue(options.scenario.tags)),
        options.scenario.priority ?? null,
        encodeJson(redactValue(options.scenario.expectations)),
        encodeJson(redactValue(options.scenario)),
        encodeJson(redactValue(options.persona)),
        encodeJson(redactValue(options.rubric)),
        options.rubric.passThreshold,
        options.rubric.judge?.provider ?? null,
        options.rubric.judge?.model ?? null,
        options.rubric.judge?.temperature ?? null,
        options.rubric.judge?.maxTokens ?? null,
        now,
        now,
      );
    const row = this.database
      .query("select last_insert_rowid() as id")
      .get() as { id: number };
    refreshRunCounts(this.database, this.requireRunId());
    return row.id;
  }

  recordTurn(
    scenarioRunId: number,
    options: {
      turnIndex: number;
      turn: { role: string; content?: string | null };
      source: string;
      generatorModel?: string;
    },
  ): void {
    this.database
      .query(
        `
          insert into turns (
            scenario_run_id, turn_index, role, source, content, generator_model, created_at
          ) values (?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        scenarioRunId,
        options.turnIndex,
        options.turn.role,
        options.source,
        options.turn.content ?? null,
        options.generatorModel ?? null,
        utcNow(),
      );
    this.database
      .query(
        `
          update scenario_runs
          set turn_count = turn_count + 1,
              assistant_turn_count = assistant_turn_count + ?,
              updated_at = ?
          where id = ?
        `,
      )
      .run(options.source === "assistant" ? 1 : 0, utcNow(), scenarioRunId);
  }

  recordAssistantReply(
    scenarioRunId: number,
    options: { turnIndex: number; reply: AdapterReply },
  ): void {
    this.database
      .query(
        `
          update turns
          set latency_ms = ?, usage_json = ?
          where scenario_run_id = ? and turn_index = ?
        `,
      )
      .run(
        options.reply.latencyMs,
        encodeJson(redactValue(options.reply.usage)),
        scenarioRunId,
        options.turnIndex,
      );

    const exchangeRow = this.database
      .query(
        "select coalesce(max(exchange_index), -1) + 1 as next_exchange from target_events where scenario_run_id = ? and turn_index = ?",
      )
      .get(scenarioRunId, options.turnIndex) as { next_exchange: number };
    this.database
      .query(
        `
          insert into target_events (
            scenario_run_id, turn_index, exchange_index, raw_exchange_json, latency_ms, usage_json, created_at
          ) values (?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        scenarioRunId,
        options.turnIndex,
        exchangeRow.next_exchange,
        encodeJson(redactValue(options.reply.rawExchange)),
        options.reply.latencyMs,
        encodeJson(redactValue(options.reply.usage)),
        utcNow(),
      );

    for (const toolCall of options.reply.toolCalls) {
      this.database
        .query(
          `
            insert into tool_calls (
              scenario_run_id, turn_index, call_order, name, args_json, raw_json, created_at
            ) values (?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          scenarioRunId,
          options.turnIndex,
          toolCall.order ?? null,
          toolCall.name,
          encodeJson(redactValue(toolCall.args)),
          encodeJson(redactValue(toolCall.raw)),
          utcNow(),
        );
    }

    this.database
      .query(
        `
          update scenario_runs
          set tool_call_count = tool_call_count + ?, updated_at = ?
          where id = ?
        `,
      )
      .run(options.reply.toolCalls.length, utcNow(), scenarioRunId);
  }

  recordCheckpoint(
    scenarioRunId: number,
    options: {
      checkpointIndex: number;
      precedingTurnIndex?: number;
      assertions: CheckpointAssertion[];
      result: CheckpointResult;
    },
  ): void {
    this.database
      .query(
        `
          insert into checkpoints (
            scenario_run_id, checkpoint_index, preceding_turn_index, passed, failures_json, assertions_json, created_at
          ) values (?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        scenarioRunId,
        options.checkpointIndex,
        options.precedingTurnIndex ?? null,
        options.result.passed ? 1 : 0,
        encodeJson(redactValue(options.result.failures)),
        encodeJson(redactValue(options.assertions)),
        utcNow(),
      );
    this.database
      .query(
        `
          update scenario_runs
          set checkpoint_count = checkpoint_count + 1, updated_at = ?
          where id = ?
        `,
      )
      .run(utcNow(), scenarioRunId);
  }

  recordJudgeResult(
    scenarioRunId: number,
    options: {
      rubric: Rubric;
      score: RubricScore;
      overallScore: number;
    },
  ): void {
    for (const dimension of options.rubric.dimensions) {
      const dimensionScore = options.score.dimensions[dimension.id];
      if (!dimensionScore) {
        continue;
      }
      this.database
        .query(
          `
            insert into judge_dimension_scores (
              scenario_run_id, dimension_id, dimension_name, weight, scale_type,
              scale_points, raw_score, normalized_score, reasoning, evidence_json, created_at
            ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          scenarioRunId,
          dimension.id,
          dimension.name,
          dimension.weight,
          dimension.scale.type,
          dimension.scale.points ?? null,
          dimensionScore.score,
          normalizedDimensionScore(
            options.rubric,
            dimension.id,
            dimensionScore.score,
          ),
          dimensionScore.reasoning,
          encodeJson(redactValue(dimensionScore.evidence)),
          utcNow(),
        );
    }

    this.database
      .query(
        `
          update scenario_runs
          set overall_score = ?,
              overall_notes = ?,
              judge_output_json = ?,
              updated_at = ?
          where id = ?
        `,
      )
      .run(
        options.overallScore,
        options.score.overallNotes,
        encodeJson(
          redactValue({
            dimensions: options.score.dimensions,
            overall_notes: options.score.overallNotes,
            pass: options.score.passed,
            failure_mode_detected: options.score.failureModeDetected ?? null,
          }),
        ),
        utcNow(),
        scenarioRunId,
      );
  }

  recordScenarioFinished(
    scenarioRunId: number,
    options: { result: ScenarioRunResult },
  ): void {
    this.database
      .query(
        `
          update scenario_runs
          set status = 'completed',
              passed = ?,
              overall_score = ?,
              completed_at = ?,
              updated_at = ?
          where id = ?
        `,
      )
      .run(
        options.result.passed ? 1 : 0,
        options.result.overallScore,
        utcNow(),
        utcNow(),
        scenarioRunId,
      );
    refreshRunCounts(this.database, this.requireRunId());
  }

  recordScenarioError(scenarioRunId: number, error: Error): void {
    this.database
      .query(
        `
          update scenario_runs
          set status = ?,
              passed = 0,
              error_json = ?,
              completed_at = ?,
              updated_at = ?
          where id = ?
        `,
      )
      .run(
        scenarioStatusForError(error),
        encodeJson(errorPayload(error)),
        utcNow(),
        utcNow(),
        scenarioRunId,
      );
    refreshRunCounts(this.database, this.requireRunId());
  }
}

function mapRunSummaryRow(row: Record<string, unknown>): RunSummary {
  return {
    runId: String(row.id),
    status: String(row.status),
    passed:
      row.passed === null || row.passed === undefined
        ? null
        : Number(row.passed) === 1,
    exitCode:
      row.exit_code === null || row.exit_code === undefined
        ? null
        : Number(row.exit_code),
    preset: typeof row.preset === "string" ? row.preset : null,
    startedAt: String(row.started_at),
    completedAt: typeof row.completed_at === "string" ? row.completed_at : null,
    suiteFingerprint:
      typeof row.suite_fingerprint === "string" ? row.suite_fingerprint : null,
    finalError:
      decodeJson<Record<string, JsonValue>>(row.final_error_json) ?? null,
    aggregateCounts: {
      scenarioTotal: Number(row.scenario_total ?? 0),
      scenarioPassedCount: Number(row.scenario_passed_count ?? 0),
      scenarioFailedCount: Number(row.scenario_failed_count ?? 0),
      scenarioErroredCount: Number(row.scenario_errored_count ?? 0),
    },
  };
}

export function listRuns(options: { dbUrl?: string } = {}): RunSummary[] {
  const database = openDatabase(options.dbUrl);
  try {
    const rows = database
      .query("select * from runs order by started_at desc")
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => mapRunSummaryRow(row));
  } finally {
    database.close();
  }
}

function getScenarioRecords(
  database: Database,
  runId: string,
): RunRecord["scenarios"] {
  const scenarioRows = database
    .query("select * from scenario_runs where run_id = ? order by ordinal asc")
    .all(runId) as Array<Record<string, unknown>>;

  return scenarioRows.map((row) => {
    const scenarioRunId = Number(row.id);
    const turns = database
      .query(
        "select * from turns where scenario_run_id = ? order by turn_index asc",
      )
      .all(scenarioRunId) as Array<Record<string, unknown>>;
    const targetEvents = database
      .query(
        "select * from target_events where scenario_run_id = ? order by turn_index asc, exchange_index asc",
      )
      .all(scenarioRunId) as Array<Record<string, unknown>>;
    const toolCalls = database
      .query(
        "select * from tool_calls where scenario_run_id = ? order by turn_index asc, call_order asc",
      )
      .all(scenarioRunId) as Array<Record<string, unknown>>;
    const checkpoints = database
      .query(
        "select * from checkpoints where scenario_run_id = ? order by checkpoint_index asc",
      )
      .all(scenarioRunId) as Array<Record<string, unknown>>;
    const judgeDimensionScores = database
      .query(
        "select * from judge_dimension_scores where scenario_run_id = ? order by dimension_id asc",
      )
      .all(scenarioRunId) as Array<Record<string, unknown>>;

    return {
      scenarioRunId,
      ordinal: Number(row.ordinal),
      scenarioId: String(row.scenario_id),
      scenarioName: String(row.scenario_name),
      personaId: String(row.persona_id),
      rubricId: String(row.rubric_id),
      userId: typeof row.user_id === "string" ? row.user_id : null,
      tags: decodeJson<JsonValue>(row.tags_json),
      priority: typeof row.priority === "string" ? row.priority : null,
      expectations: decodeJson<JsonValue>(row.expectations_json),
      scenarioSnapshot: decodeJson<JsonValue>(row.scenario_snapshot_json),
      personaSnapshot: decodeJson<JsonValue>(row.persona_snapshot_json),
      rubricSnapshot: decodeJson<JsonValue>(row.rubric_snapshot_json),
      status: String(row.status),
      passed:
        row.passed === null || row.passed === undefined
          ? null
          : Number(row.passed) === 1,
      overallScore:
        row.overall_score === null || row.overall_score === undefined
          ? null
          : Number(row.overall_score),
      passThreshold:
        row.pass_threshold === null || row.pass_threshold === undefined
          ? null
          : Number(row.pass_threshold),
      judge: {
        provider:
          typeof row.judge_provider === "string" ? row.judge_provider : null,
        model: typeof row.judge_model === "string" ? row.judge_model : null,
        temperature:
          row.judge_temperature === null || row.judge_temperature === undefined
            ? null
            : Number(row.judge_temperature),
        maxTokens:
          row.judge_max_tokens === null || row.judge_max_tokens === undefined
            ? null
            : Number(row.judge_max_tokens),
        overallNotes:
          typeof row.overall_notes === "string" ? row.overall_notes : null,
        output: decodeJson<JsonValue>(row.judge_output_json),
      },
      counts: {
        turnCount: Number(row.turn_count ?? 0),
        assistantTurnCount: Number(row.assistant_turn_count ?? 0),
        toolCallCount: Number(row.tool_call_count ?? 0),
        checkpointCount: Number(row.checkpoint_count ?? 0),
      },
      turns: turns.map((turn) => ({
        turn_index: Number(turn.turn_index),
        role: String(turn.role),
        source: String(turn.source),
        content: typeof turn.content === "string" ? turn.content : null,
        generator_model:
          typeof turn.generator_model === "string"
            ? turn.generator_model
            : null,
        latency_ms:
          turn.latency_ms === null || turn.latency_ms === undefined
            ? null
            : Number(turn.latency_ms),
        usage: decodeJson<JsonValue>(turn.usage_json) ?? null,
        created_at: String(turn.created_at),
      })),
      targetEvents: targetEvents.map((event) => ({
        turn_index: Number(event.turn_index),
        exchange_index: Number(event.exchange_index),
        raw_exchange: decodeJson<JsonValue>(event.raw_exchange_json) ?? null,
        latency_ms:
          event.latency_ms === null || event.latency_ms === undefined
            ? null
            : Number(event.latency_ms),
        usage: decodeJson<JsonValue>(event.usage_json) ?? null,
      })),
      toolCalls: toolCalls.map((call) => ({
        turn_index: Number(call.turn_index),
        call_order:
          call.call_order === null || call.call_order === undefined
            ? null
            : Number(call.call_order),
        name: String(call.name),
        args: decodeJson<JsonValue>(call.args_json) ?? {},
        raw: decodeJson<JsonValue>(call.raw_json) ?? null,
      })),
      checkpoints: checkpoints.map((checkpoint) => ({
        checkpoint_index: Number(checkpoint.checkpoint_index),
        preceding_turn_index:
          checkpoint.preceding_turn_index === null ||
          checkpoint.preceding_turn_index === undefined
            ? null
            : Number(checkpoint.preceding_turn_index),
        passed: Number(checkpoint.passed) === 1,
        failures: decodeJson<JsonValue>(checkpoint.failures_json) ?? [],
        assertions: decodeJson<JsonValue>(checkpoint.assertions_json) ?? [],
      })),
      judgeDimensionScores: judgeDimensionScores.map((score) => ({
        dimension_id: String(score.dimension_id),
        dimension_name: String(score.dimension_name),
        weight: Number(score.weight),
        scale_type: String(score.scale_type),
        scale_points:
          score.scale_points === null || score.scale_points === undefined
            ? null
            : Number(score.scale_points),
        raw_score: Number(score.raw_score),
        normalized_score: Number(score.normalized_score),
        reasoning: String(score.reasoning),
        evidence: decodeJson<JsonValue>(score.evidence_json) ?? [],
      })),
      error: decodeJson<Record<string, JsonValue>>(row.error_json) ?? null,
      startedAt: String(row.started_at),
      completedAt:
        typeof row.completed_at === "string" ? row.completed_at : null,
    };
  });
}

export function getRun(
  runId: string,
  options: { dbUrl?: string } = {},
): RunRecord | undefined {
  const database = openDatabase(options.dbUrl);
  try {
    const row = database
      .query("select * from runs where id = ?")
      .get(runId) as Record<string, unknown> | null;
    if (!row) {
      return undefined;
    }
    const summary = mapRunSummaryRow(row);
    return {
      ...summary,
      sourcePaths:
        decodeJson<Record<string, string>>(row.source_paths_json) ?? null,
      endpointSnapshot:
        decodeJson<Record<string, JsonValue>>(row.endpoint_snapshot_json) ??
        null,
      selectedScenarioIds:
        decodeJson<string[]>(row.selected_scenario_ids_json) ?? null,
      scenarios: getScenarioRecords(database, runId),
    };
  } finally {
    database.close();
  }
}

export function latestRunForSuite(
  suiteFingerprint: string,
  options: { beforeStartedAt?: string; dbUrl?: string } = {},
): RunRecord | undefined {
  const database = openDatabase(options.dbUrl);
  try {
    const rows = database
      .query(
        "select id, started_at from runs where suite_fingerprint = ? order by started_at desc",
      )
      .all(suiteFingerprint) as Array<{ id?: string; started_at?: string }>;
    const cutoffTimestamp =
      typeof options.beforeStartedAt === "string"
        ? normalizeUtcTimestamp(options.beforeStartedAt)
        : undefined;
    const row =
      cutoffTimestamp === undefined
        ? rows[0]
        : rows.find((candidate) => {
            if (typeof candidate.started_at !== "string") {
              return false;
            }
            const startedAt = normalizeUtcTimestamp(candidate.started_at);
            return startedAt !== undefined && startedAt < cutoffTimestamp;
          });
    if (!row?.id) {
      return undefined;
    }
    return getRun(row.id, options);
  } finally {
    database.close();
  }
}

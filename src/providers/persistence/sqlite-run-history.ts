import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type {
  AdapterReply,
  CheckpointAssertion,
  CheckpointResult,
  Endpoints,
  JsonValue,
  Persona,
  PresetRecord,
  PresetSnapshot,
  Rubric,
  RubricScore,
  RunRecord,
  RunResult,
  RunSummary,
  Scenario,
  ScenarioRunResult,
  ScenarioSelectionRef,
} from "../../shared/types/contracts.ts";
import {
  AgentProbeRuntimeError,
  errorPayload,
} from "../../shared/utils/errors.ts";
import {
  filtersPayload,
  hashValue,
  normalizedDimensionScore,
  redactValue,
  runStatusForExitCode,
  scenarioStatusForError,
  sourcePathsPayload,
  utcNow,
} from "./recorder-common.ts";

export const DEFAULT_DB_DIRNAME = ".agentprobe";
export const DEFAULT_DB_FILENAME = "runs.sqlite3";
export const SCHEMA_VERSION = 4;

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
  const database = new Database(resolveDbPath(dbUrl));
  database.exec("pragma foreign_keys = on;");
  try {
    database.exec("pragma journal_mode = WAL;");
  } catch {
    // Some SQLite targets may not support WAL; writes still work without it.
  }
  return database;
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

function ensurePhase2RunColumns(database: Database): void {
  ensureColumn(database, "runs", "label", "text");
  ensureColumn(database, "runs", "trigger", "text not null default 'cli'");
  ensureColumn(database, "runs", "cancelled_at", "text");
  ensureColumn(database, "runs", "preset_id", "text");
  ensureColumn(database, "runs", "preset_snapshot_json", "text");
}

function migrateDatabase(database: Database, currentVersion: number): void {
  let version = currentVersion;
  if (version < 2) {
    ensureColumn(database, "scenario_runs", "user_id", "text");
    database.query("update meta set schema_version = ? where id = 1").run(2);
    version = 2;
  }
  if (version < 3) {
    ensureColumn(database, "scenario_runs", "failure_kind", "text");
    ensureColumn(
      database,
      "runs",
      "scenario_harness_failed_count",
      "integer not null default 0",
    );
    database.query("update meta set schema_version = ? where id = 1").run(3);
    version = 3;
  }
  if (version < 4) {
    ensurePhase2RunColumns(database);
    ensurePhase2Schema(database);
    database.query("update meta set schema_version = ? where id = 1").run(4);
    version = 4;
  }

  if (version !== SCHEMA_VERSION) {
    throw new AgentProbeRuntimeError(
      `Unsupported run-history schema version ${version}; expected ${SCHEMA_VERSION}.`,
    );
  }
}

function ensurePhase2Schema(database: Database): void {
  ensurePhase2RunColumns(database);
  database.exec(`
    create table if not exists presets (
      id text primary key,
      name text not null unique,
      description text,
      endpoint text not null,
      personas text not null,
      rubric text not null,
      parallel_enabled integer not null default 0,
      parallel_limit integer,
      repeat integer not null default 1,
      dry_run integer not null default 0,
      created_at text not null,
      updated_at text not null,
      deleted_at text
    );

    create table if not exists preset_scenarios (
      preset_id text not null references presets(id) on delete cascade,
      file text not null,
      scenario_id text not null,
      position integer not null,
      primary key (preset_id, file, scenario_id)
    );

    create index if not exists idx_runs_status on runs(status);
    create index if not exists idx_runs_trigger on runs(trigger);
    create index if not exists idx_runs_preset_id on runs(preset_id);
    create index if not exists idx_runs_started_at on runs(started_at);
    create index if not exists idx_preset_scenarios_position
      on preset_scenarios(preset_id, position);
  `);
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
        label text,
        trigger text not null default 'cli',
        cancelled_at text,
        preset_id text,
        preset_snapshot_json text,
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
        scenario_harness_failed_count integer not null default 0,
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
        failure_kind text,
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
    ensurePhase2Schema(database);

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
      "select status, passed, failure_kind from scenario_runs where run_id = ? order by ordinal asc",
    )
    .all(runId) as Array<{
    status: string;
    passed: number | null;
    failure_kind: string | null;
  }>;
  const scenarioTotal = rows.length;
  const scenarioPassedCount = rows.filter(
    (row) => row.status === "completed" && row.passed === 1,
  ).length;
  const scenarioFailedCount = rows.filter(
    (row) => row.status === "completed" && row.passed === 0,
  ).length;
  const scenarioHarnessFailedCount = rows.filter(
    (row) =>
      row.status === "completed" &&
      row.passed === 0 &&
      row.failure_kind === "harness",
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
            scenario_harness_failed_count = ?,
            scenario_errored_count = ?,
            updated_at = ?
        where id = ?
      `,
    )
    .run(
      scenarioTotal,
      scenarioPassedCount,
      scenarioFailedCount,
      scenarioHarnessFailedCount,
      scenarioErroredCount,
      utcNow(),
      runId,
    );
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
    label?: string;
    trigger?: string;
    presetId?: string | null;
    presetSnapshot?: PresetSnapshot | Record<string, JsonValue> | null;
  }): string {
    const runId = randomUUID().replaceAll("-", "");
    const now = utcNow();
    this.database
      .query(
        `
          insert into runs (
            id, status, passed, exit_code, label, trigger, preset_id,
            preset_snapshot_json, filters_json, selected_scenario_ids_json,
            source_paths_json, scenario_total, scenario_passed_count,
            scenario_failed_count, scenario_errored_count, started_at, updated_at
          ) values (?, 'running', null, null, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, ?, ?)
        `,
      )
      .run(
        runId,
        options.label ?? null,
        options.trigger ?? "cli",
        options.presetId ?? null,
        encodeJson(redactValue(options.presetSnapshot ?? null)),
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
          set status = ?,
              passed = ?,
              exit_code = ?,
              completed_at = ?,
              cancelled_at = ?,
              updated_at = ?
          where id = ?
        `,
      )
      .run(
        result.cancelled ? "cancelled" : "completed",
        result.cancelled ? 0 : result.passed ? 1 : 0,
        result.exitCode,
        utcNow(),
        result.cancelled ? utcNow() : null,
        utcNow(),
        this.requireRunId(),
      );
  }

  recordRunCancelled(result?: RunResult): void {
    refreshRunCounts(this.database, this.requireRunId());
    const now = utcNow();
    this.database
      .query(
        `
          update runs
          set status = 'cancelled',
              passed = 0,
              exit_code = ?,
              completed_at = ?,
              cancelled_at = ?,
              updated_at = ?
          where id = ?
        `,
      )
      .run(result?.exitCode ?? 130, now, now, now, this.requireRunId());
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
              failure_kind = ?,
              overall_score = ?,
              completed_at = ?,
              updated_at = ?
          where id = ?
        `,
      )
      .run(
        options.result.passed ? 1 : 0,
        options.result.failureKind ?? null,
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

type PresetWriteInput = {
  name: string;
  description?: string | null;
  endpoint: string;
  personas: string;
  rubric: string;
  selection: ScenarioSelectionRef[];
  parallel?: {
    enabled?: boolean;
    limit?: number | null;
  };
  repeat?: number;
  dryRun?: boolean;
};

function readPresetSelection(
  database: Database,
  presetId: string,
): ScenarioSelectionRef[] {
  const rows = database
    .query(
      "select file, scenario_id from preset_scenarios where preset_id = ? order by position asc",
    )
    .all(presetId) as Array<{ file?: string; scenario_id?: string }>;
  return rows.map((row) => ({
    file: String(row.file),
    id: String(row.scenario_id),
  }));
}

function mapPresetRow(
  row: Record<string, unknown>,
  selection: ScenarioSelectionRef[],
  lastRun?: RunSummary | null,
): PresetRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    description: typeof row.description === "string" ? row.description : null,
    endpoint: String(row.endpoint),
    personas: String(row.personas),
    rubric: String(row.rubric),
    selection,
    parallel: {
      enabled: Number(row.parallel_enabled ?? 0) === 1,
      limit:
        row.parallel_limit === null || row.parallel_limit === undefined
          ? null
          : Number(row.parallel_limit),
    },
    repeat: Number(row.repeat ?? 1),
    dryRun: Number(row.dry_run ?? 0) === 1,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    deletedAt: typeof row.deleted_at === "string" ? row.deleted_at : null,
    lastRun: lastRun ?? null,
  };
}

function replacePresetScenarios(
  database: Database,
  presetId: string,
  selection: ScenarioSelectionRef[],
): void {
  database
    .query("delete from preset_scenarios where preset_id = ?")
    .run(presetId);
  const insert = database.query(
    `
      insert into preset_scenarios (preset_id, file, scenario_id, position)
      values (?, ?, ?, ?)
    `,
  );
  selection.forEach((item, index) => {
    insert.run(presetId, item.file, item.id, index);
  });
}

function latestRunForPresetRow(
  database: Database,
  presetId: string,
): RunSummary | null {
  const row = database
    .query(
      "select * from runs where preset_id = ? order by started_at desc limit 1",
    )
    .get(presetId) as Record<string, unknown> | null;
  return row ? mapRunSummaryRow(row) : null;
}

export function createPreset(
  input: PresetWriteInput,
  options: { dbUrl?: string } = {},
): PresetRecord {
  const database = openDatabase(options.dbUrl);
  const presetId = randomUUID().replaceAll("-", "");
  const now = utcNow();
  try {
    database.exec("begin immediate;");
    database
      .query(
        `
          insert into presets (
            id, name, description, endpoint, personas, rubric,
            parallel_enabled, parallel_limit, repeat, dry_run, created_at, updated_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        presetId,
        input.name,
        input.description ?? null,
        input.endpoint,
        input.personas,
        input.rubric,
        input.parallel?.enabled ? 1 : 0,
        input.parallel?.limit ?? null,
        input.repeat ?? 1,
        input.dryRun ? 1 : 0,
        now,
        now,
      );
    replacePresetScenarios(database, presetId, input.selection);
    database.exec("commit;");
    const row = database
      .query("select * from presets where id = ?")
      .get(presetId) as Record<string, unknown>;
    return mapPresetRow(row, input.selection, null);
  } catch (error) {
    try {
      database.exec("rollback;");
    } catch {}
    throw error;
  } finally {
    database.close();
  }
}

export function getPreset(
  presetId: string,
  options: { dbUrl?: string; includeDeleted?: boolean } = {},
): PresetRecord | undefined {
  const database = openDatabase(options.dbUrl);
  try {
    const row = database
      .query(
        options.includeDeleted
          ? "select * from presets where id = ?"
          : "select * from presets where id = ? and deleted_at is null",
      )
      .get(presetId) as Record<string, unknown> | null;
    if (!row) {
      return undefined;
    }
    return mapPresetRow(
      row,
      readPresetSelection(database, presetId),
      latestRunForPresetRow(database, presetId),
    );
  } finally {
    database.close();
  }
}

export function listPresets(
  options: { dbUrl?: string; includeDeleted?: boolean } = {},
): PresetRecord[] {
  const database = openDatabase(options.dbUrl);
  try {
    const rows = database
      .query(
        options.includeDeleted
          ? "select * from presets order by updated_at desc"
          : "select * from presets where deleted_at is null order by updated_at desc",
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) =>
      mapPresetRow(
        row,
        readPresetSelection(database, String(row.id)),
        latestRunForPresetRow(database, String(row.id)),
      ),
    );
  } finally {
    database.close();
  }
}

export function updatePreset(
  presetId: string,
  input: Partial<PresetWriteInput>,
  options: { dbUrl?: string } = {},
): PresetRecord | undefined {
  const existing = getPreset(presetId, options);
  if (!existing) {
    return undefined;
  }
  const merged: PresetWriteInput = {
    name: input.name ?? existing.name,
    description:
      input.description !== undefined
        ? input.description
        : existing.description,
    endpoint: input.endpoint ?? existing.endpoint,
    personas: input.personas ?? existing.personas,
    rubric: input.rubric ?? existing.rubric,
    selection: input.selection ?? existing.selection,
    parallel: input.parallel ?? existing.parallel,
    repeat: input.repeat ?? existing.repeat,
    dryRun: input.dryRun ?? existing.dryRun,
  };
  const database = openDatabase(options.dbUrl);
  const now = utcNow();
  try {
    database.exec("begin immediate;");
    database
      .query(
        `
          update presets
          set name = ?,
              description = ?,
              endpoint = ?,
              personas = ?,
              rubric = ?,
              parallel_enabled = ?,
              parallel_limit = ?,
              repeat = ?,
              dry_run = ?,
              updated_at = ?
          where id = ? and deleted_at is null
        `,
      )
      .run(
        merged.name,
        merged.description ?? null,
        merged.endpoint,
        merged.personas,
        merged.rubric,
        merged.parallel?.enabled ? 1 : 0,
        merged.parallel?.limit ?? null,
        merged.repeat ?? 1,
        merged.dryRun ? 1 : 0,
        now,
        presetId,
      );
    replacePresetScenarios(database, presetId, merged.selection);
    database.exec("commit;");
    return getPreset(presetId, options);
  } catch (error) {
    try {
      database.exec("rollback;");
    } catch {}
    throw error;
  } finally {
    database.close();
  }
}

export function softDeletePreset(
  presetId: string,
  options: { dbUrl?: string } = {},
): PresetRecord | undefined {
  const database = openDatabase(options.dbUrl);
  const now = utcNow();
  try {
    database
      .query(
        "update presets set deleted_at = ?, updated_at = ? where id = ? and deleted_at is null",
      )
      .run(now, now, presetId);
  } finally {
    database.close();
  }
  return getPreset(presetId, { ...options, includeDeleted: true });
}

export function listRunsForPreset(
  presetId: string,
  options: { dbUrl?: string } = {},
): RunSummary[] {
  const database = openDatabase(options.dbUrl);
  try {
    const rows = database
      .query("select * from runs where preset_id = ? order by started_at desc")
      .all(presetId) as Array<Record<string, unknown>>;
    return rows.map((row) => mapRunSummaryRow(row));
  } finally {
    database.close();
  }
}

export function markRunCancelled(
  runId: string,
  options: { dbUrl?: string; exitCode?: number } = {},
): RunRecord | undefined {
  const database = openDatabase(options.dbUrl);
  const now = utcNow();
  try {
    database
      .query(
        `
          update runs
          set status = 'cancelled',
              passed = 0,
              exit_code = ?,
              cancelled_at = ?,
              completed_at = coalesce(completed_at, ?),
              updated_at = ?
          where id = ?
        `,
      )
      .run(options.exitCode ?? 130, now, now, now, runId);
  } finally {
    database.close();
  }
  return getRun(runId, options);
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
    label: typeof row.label === "string" ? row.label : null,
    trigger: typeof row.trigger === "string" ? row.trigger : null,
    cancelledAt: typeof row.cancelled_at === "string" ? row.cancelled_at : null,
    presetId: typeof row.preset_id === "string" ? row.preset_id : null,
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
      scenarioHarnessFailedCount: Number(
        row.scenario_harness_failed_count ?? 0,
      ),
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
      failureKind:
        row.failure_kind === "harness"
          ? "harness"
          : row.failure_kind === "agent"
            ? "agent"
            : null,
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
      presetSnapshot:
        decodeJson<Record<string, JsonValue>>(row.preset_snapshot_json) ?? null,
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

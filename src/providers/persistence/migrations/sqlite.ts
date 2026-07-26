import type { Database } from "bun:sqlite";

import { resolveSqlitePath, withSqliteDatabase } from "../sqlite-connection.ts";
import type { MigrationReport, MigrationRunner } from "./types.ts";

/** Target schema version for SQLite. Keep synced with SCHEMA_VERSION in sqlite-run-history.ts. */
export const SQLITE_TARGET_VERSION = 8;

function utcNow(): string {
  return new Date().toISOString();
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

/** Apply the baseline schema on a fresh database. */
export function applySqliteBaseline(database: Database): void {
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
      notes text,
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

    create table if not exists human_dimension_scores (
      id integer primary key autoincrement,
      scenario_run_id integer not null references scenario_runs(id) on delete cascade,
      dimension_id text not null,
      dimension_name text not null,
      scale_type text not null,
      scale_points real,
      raw_score real not null,
      normalized_score real not null,
      created_at text not null
    );

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

    create table if not exists app_settings (
      key text primary key,
      ciphertext text not null,
      iv text not null,
      auth_tag text not null,
      updated_at text not null
    );

    create table if not exists endpoint_overrides (
      endpoint_path text primary key,
      overrides_json text not null,
      updated_at text not null
    );

    create index if not exists idx_runs_status on runs(status);
    create index if not exists idx_runs_trigger on runs(trigger);
    create index if not exists idx_runs_preset_id on runs(preset_id);
    create index if not exists idx_runs_started_at on runs(started_at);
    create index if not exists idx_preset_scenarios_position
      on preset_scenarios(preset_id, position);
    create index if not exists idx_scenario_runs_run_id
      on scenario_runs(run_id);
    create index if not exists idx_scenario_runs_scenario_id
      on scenario_runs(scenario_id);
    create unique index if not exists idx_human_dim_scores_unique
      on human_dimension_scores(scenario_run_id, dimension_id);
    create index if not exists idx_human_dim_scores_scenario_run
      on human_dimension_scores(scenario_run_id);
  `);
}

/** Apply version-bump migrations on an already initialized database. */
export function applySqliteMigrations(
  database: Database,
  fromVersion: number,
): number[] {
  const applied: number[] = [];
  let version = fromVersion;
  if (version < 2) {
    ensureColumn(database, "scenario_runs", "user_id", "text");
    database.query("update meta set schema_version = ? where id = 1").run(2);
    applied.push(2);
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
    applied.push(3);
    version = 3;
  }
  if (version < 4) {
    ensureColumn(database, "runs", "label", "text");
    ensureColumn(database, "runs", "trigger", "text not null default 'cli'");
    ensureColumn(database, "runs", "cancelled_at", "text");
    ensureColumn(database, "runs", "preset_id", "text");
    ensureColumn(database, "runs", "preset_snapshot_json", "text");
    applySqliteBaseline(database);
    database.query("update meta set schema_version = ? where id = 1").run(4);
    applied.push(4);
    version = 4;
  }
  if (version < 5) {
    ensureColumn(database, "runs", "notes", "text");
    database.query("update meta set schema_version = ? where id = 1").run(5);
    applied.push(5);
    version = 5;
  }
  if (version < 6) {
    database.exec(`
      create table if not exists app_settings (
        key text primary key,
        ciphertext text not null,
        iv text not null,
        auth_tag text not null,
        updated_at text not null
      );
    `);
    database.query("update meta set schema_version = ? where id = 1").run(6);
    applied.push(6);
    version = 6;
  }
  if (version < 7) {
    database.exec(`
      create table if not exists endpoint_overrides (
        endpoint_path text primary key,
        overrides_json text not null,
        updated_at text not null
      );
    `);
    database.query("update meta set schema_version = ? where id = 1").run(7);
    applied.push(7);
    version = 7;
  }
  if (version < 8) {
    database.exec(`
      create table if not exists human_dimension_scores (
        id integer primary key autoincrement,
        scenario_run_id integer not null references scenario_runs(id) on delete cascade,
        dimension_id text not null,
        dimension_name text not null,
        scale_type text not null,
        scale_points real,
        raw_score real not null,
        normalized_score real not null,
        created_at text not null
      );
      create unique index if not exists idx_human_dim_scores_unique
        on human_dimension_scores(scenario_run_id, dimension_id);
      create index if not exists idx_human_dim_scores_scenario_run
        on human_dimension_scores(scenario_run_id);
    `);
    database.query("update meta set schema_version = ? where id = 1").run(8);
    applied.push(8);
    version = 8;
  }
  return applied;
}

function hasMetaTable(database: Database): boolean {
  return Boolean(
    database
      .query(
        "select name from sqlite_master where type='table' and name='meta'",
      )
      .get(),
  );
}

export function readSqliteVersion(database: Database): number {
  if (!hasMetaTable(database)) {
    return 0;
  }
  const row = database
    .query("select schema_version from meta where id = 1")
    .get() as { schema_version?: number } | null;
  return row?.schema_version ?? 0;
}

export function createSqliteMigrationRunner(
  dbUrl: string,
  displayUrl: string,
): MigrationRunner {
  const path = resolveSqlitePath(dbUrl);
  return {
    backend: "sqlite",
    displayUrl,
    targetVersion: SQLITE_TARGET_VERSION,
    currentVersion(): number {
      return withSqliteDatabase(path, (database) => {
        const hasMeta = database
          .query(
            "select name from sqlite_master where type='table' and name='meta'",
          )
          .get();
        return hasMeta ? readSqliteVersion(database) : 0;
      });
    },
    migrate(): number[] {
      return withSqliteDatabase(path, (database) => {
        const existing = readSqliteVersion(database);
        if (existing === 0) {
          applySqliteBaseline(database);
          database
            .query(
              "insert into meta (id, schema_version, created_at) values (1, ?, ?)",
            )
            .run(SQLITE_TARGET_VERSION, utcNow());
          return [SQLITE_TARGET_VERSION];
        }
        return applySqliteMigrations(database, existing);
      });
    },
  };
}

export type { MigrationReport };

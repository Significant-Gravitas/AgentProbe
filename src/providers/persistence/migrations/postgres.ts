import { createPostgresClient, type SqlTag } from "../postgres-client.ts";
import type { MigrationRunner } from "./types.ts";

/** Target schema version for Postgres. Bumps whenever a new migration is added. */
export const POSTGRES_TARGET_VERSION = 4;

const POSTGRES_BASELINE_DDL = `
  create table if not exists meta (
    id integer primary key,
    schema_version integer not null,
    created_at timestamptz not null default now()
  );

  create table if not exists runs (
    id text primary key,
    status text not null,
    passed boolean,
    exit_code integer,
    transport text,
    preset text,
    label text,
    notes text,
    trigger text not null default 'cli',
    cancelled_at timestamptz,
    preset_id text,
    preset_snapshot_json jsonb,
    filters_json jsonb,
    selected_scenario_ids_json jsonb,
    suite_fingerprint text,
    source_paths_json jsonb,
    endpoint_config_hash text,
    scenarios_config_hash text,
    personas_config_hash text,
    rubric_config_hash text,
    endpoint_snapshot_json jsonb,
    scenario_total integer not null default 0,
    scenario_passed_count integer not null default 0,
    scenario_failed_count integer not null default 0,
    scenario_harness_failed_count integer not null default 0,
    scenario_errored_count integer not null default 0,
    final_error_json jsonb,
    started_at timestamptz not null,
    updated_at timestamptz not null,
    completed_at timestamptz
  );

  create table if not exists scenario_runs (
    id bigserial primary key,
    run_id text not null references runs(id) on delete cascade,
    ordinal integer not null,
    scenario_id text not null,
    scenario_name text not null,
    persona_id text not null,
    rubric_id text not null,
    user_id text,
    tags_json jsonb,
    priority text,
    expectations_json jsonb,
    scenario_snapshot_json jsonb,
    persona_snapshot_json jsonb,
    rubric_snapshot_json jsonb,
    status text not null,
    passed boolean,
    failure_kind text,
    overall_score double precision,
    pass_threshold double precision,
    judge_provider text,
    judge_model text,
    judge_temperature double precision,
    judge_max_tokens integer,
    overall_notes text,
    judge_output_json jsonb,
    turn_count integer not null default 0,
    assistant_turn_count integer not null default 0,
    tool_call_count integer not null default 0,
    checkpoint_count integer not null default 0,
    error_json jsonb,
    started_at timestamptz not null,
    updated_at timestamptz not null,
    completed_at timestamptz
  );

  create table if not exists turns (
    id bigserial primary key,
    scenario_run_id bigint not null references scenario_runs(id) on delete cascade,
    turn_index integer not null,
    role text not null,
    source text not null,
    content text,
    generator_model text,
    latency_ms double precision,
    usage_json jsonb,
    created_at timestamptz not null
  );

  create table if not exists target_events (
    id bigserial primary key,
    scenario_run_id bigint not null references scenario_runs(id) on delete cascade,
    turn_index integer not null,
    exchange_index integer not null,
    raw_exchange_json jsonb,
    latency_ms double precision,
    usage_json jsonb,
    created_at timestamptz not null
  );

  create table if not exists tool_calls (
    id bigserial primary key,
    scenario_run_id bigint not null references scenario_runs(id) on delete cascade,
    turn_index integer not null,
    call_order integer,
    name text not null,
    args_json jsonb,
    raw_json jsonb,
    created_at timestamptz not null
  );

  create table if not exists checkpoints (
    id bigserial primary key,
    scenario_run_id bigint not null references scenario_runs(id) on delete cascade,
    checkpoint_index integer not null,
    preceding_turn_index integer,
    passed boolean not null,
    failures_json jsonb,
    assertions_json jsonb,
    created_at timestamptz not null
  );

  create table if not exists judge_dimension_scores (
    id bigserial primary key,
    scenario_run_id bigint not null references scenario_runs(id) on delete cascade,
    dimension_id text not null,
    dimension_name text not null,
    weight double precision not null,
    scale_type text not null,
    scale_points double precision,
    raw_score double precision not null,
    normalized_score double precision not null,
    reasoning text not null,
    evidence_json jsonb,
    created_at timestamptz not null
  );

  create table if not exists human_dimension_scores (
    id bigserial primary key,
    scenario_run_id bigint not null references scenario_runs(id) on delete cascade,
    dimension_id text not null,
    dimension_name text not null,
    scale_type text not null,
    scale_points double precision,
    raw_score double precision not null,
    normalized_score double precision not null,
    created_at timestamptz not null
  );

  create table if not exists presets (
    id text primary key,
    name text not null unique,
    description text,
    endpoint text not null,
    personas text not null,
    rubric text not null,
    parallel_enabled boolean not null default false,
    parallel_limit integer,
    repeat integer not null default 1,
    dry_run boolean not null default false,
    created_at timestamptz not null,
    updated_at timestamptz not null,
    deleted_at timestamptz
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
  create index if not exists idx_runs_suite_fingerprint on runs(suite_fingerprint);
  create index if not exists idx_preset_scenarios_position
    on preset_scenarios(preset_id, position);
  create index if not exists idx_scenario_runs_run_id
    on scenario_runs(run_id);
  create index if not exists idx_scenario_runs_scenario_id
    on scenario_runs(scenario_id);
  create index if not exists idx_turns_scenario_run on turns(scenario_run_id, turn_index);
  create index if not exists idx_target_events_scenario_run
    on target_events(scenario_run_id, turn_index, exchange_index);
  create index if not exists idx_tool_calls_scenario_run
    on tool_calls(scenario_run_id, turn_index);
  create index if not exists idx_checkpoints_scenario_run
    on checkpoints(scenario_run_id, checkpoint_index);
  create index if not exists idx_judge_scores_scenario_run
    on judge_dimension_scores(scenario_run_id);
  create unique index if not exists idx_human_dim_scores_unique
    on human_dimension_scores(scenario_run_id, dimension_id);
  create index if not exists idx_human_dim_scores_scenario_run
    on human_dimension_scores(scenario_run_id);
`;

async function readPostgresVersion(sql: SqlTag): Promise<number> {
  try {
    const rows = await sql<{ schema_version: number | string }>`
      select schema_version from meta where id = 1
    `;
    if (rows.length === 0) {
      return 0;
    }
    return Number(rows[0]?.schema_version ?? 0);
  } catch {
    // meta table may not exist yet.
    return 0;
  }
}

export function createPostgresMigrationRunner(
  rawUrl: string,
  displayUrl: string,
): MigrationRunner {
  return {
    backend: "postgres",
    displayUrl,
    targetVersion: POSTGRES_TARGET_VERSION,
    async currentVersion(): Promise<number> {
      const sql = createPostgresClient(rawUrl);
      try {
        return await readPostgresVersion(sql);
      } finally {
        await sql.end?.();
      }
    },
    async migrate(): Promise<number[]> {
      const sql = createPostgresClient(rawUrl);
      try {
        const applied: number[] = [];
        const from = await readPostgresVersion(sql);
        if (from < 1) {
          await sql.begin(async (tx) => {
            await tx.unsafe(POSTGRES_BASELINE_DDL);
            await tx`
              insert into meta (id, schema_version) values (1, 1)
              on conflict (id) do update set schema_version = excluded.schema_version
            `;
          });
          applied.push(1);
        }
        if (from < 2) {
          await sql.begin(async (tx) => {
            await tx`alter table runs add column if not exists notes text`;
            await tx`update meta set schema_version = 2 where id = 1`;
          });
          applied.push(2);
        }
        if (from < 3) {
          await sql.begin(async (tx) => {
            await tx`
              create table if not exists app_settings (
                key text primary key,
                ciphertext text not null,
                iv text not null,
                auth_tag text not null,
                updated_at timestamptz not null default now()
              )
            `;
            await tx`
              create table if not exists endpoint_overrides (
                endpoint_path text primary key,
                overrides_json jsonb not null,
                updated_at timestamptz not null default now()
              )
            `;
            await tx`update meta set schema_version = 3 where id = 1`;
          });
          applied.push(3);
        }
        if (from < 4) {
          await sql.begin(async (tx) => {
            await tx`
              create table if not exists human_dimension_scores (
                id bigserial primary key,
                scenario_run_id bigint not null references scenario_runs(id) on delete cascade,
                dimension_id text not null,
                dimension_name text not null,
                scale_type text not null,
                scale_points double precision,
                raw_score double precision not null,
                normalized_score double precision not null,
                created_at timestamptz not null
              )
            `;
            await tx`
              create unique index if not exists idx_human_dim_scores_unique
                on human_dimension_scores(scenario_run_id, dimension_id)
            `;
            await tx`
              create index if not exists idx_human_dim_scores_scenario_run
                on human_dimension_scores(scenario_run_id)
            `;
            await tx`update meta set schema_version = 4 where id = 1`;
          });
          applied.push(4);
        }
        return applied;
      } finally {
        await sql.end?.();
      }
    },
  };
}

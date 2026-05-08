import { span } from "../../shared/observability/perf.ts";
import type {
  JsonValue,
  PresetRecord,
  RunRecord,
  RunSummary,
  ScenarioRecord,
  ScenarioSelectionRef,
} from "../../shared/types/contracts.ts";
import {
  AgentProbeConfigError,
  AgentProbeRuntimeError,
} from "../../shared/utils/errors.ts";
import {
  checkSchemaVersion,
  POSTGRES_TARGET_VERSION,
} from "./migrations/index.ts";
import { createPostgresClient, type SqlTag } from "./postgres-client.ts";
import { PostgresRunRecorder } from "./postgres-run-recorder.ts";
import type {
  GetRunOptions,
  HumanScoreInput,
  HumanScoringQueueItem,
  HumanScoringRubricSummary,
  ListRunsOptions,
  PresetWriteInput,
  RecordingRepository,
  RunFilters,
  RunRecorder,
  StoredEndpointOverride,
  StoredSecretEnvelope,
} from "./types.ts";

/**
 * Columns required by `mapRunSummaryRow`. Listed explicitly so list views do
 * not pay for the wide JSONB snapshot columns (`preset_snapshot_json`,
 * `endpoint_snapshot_json`, `selected_scenario_ids_json`, `source_paths_json`)
 * that only the run-detail view reads.
 */
const RUN_SUMMARY_COLUMNS = `
  id, status, passed, exit_code, preset, label, notes, trigger,
  cancelled_at, preset_id, started_at, completed_at, suite_fingerprint,
  final_error_json,
  scenario_total, scenario_passed_count, scenario_failed_count,
  scenario_harness_failed_count, scenario_errored_count
`;

/**
 * Columns required by `mapScenarioRow` minus the wide JSONB blobs that the
 * HTTP run-detail and per-scenario routes strip from the response anyway
 * (`tags_json`, `expectations_json`, `scenario_snapshot_json`,
 * `persona_snapshot_json`, `rubric_snapshot_json`). Used when `getRun` is
 * called with `summary` or a specific `ordinal`; internal callers (report
 * rendering, preset rebase, comparison) still get every column.
 */
const SCENARIO_RUN_HTTP_COLUMNS = `
  id, run_id, ordinal, scenario_id, scenario_name, persona_id, rubric_id,
  user_id, priority, status, passed, failure_kind,
  overall_score, pass_threshold,
  judge_provider, judge_model, judge_temperature, judge_max_tokens,
  overall_notes, judge_output_json,
  turn_count, assistant_turn_count, tool_call_count, checkpoint_count,
  error_json, started_at, updated_at, completed_at
`;

const MAX_LIST_RUNS_LIMIT = 1000;

function buildRunFilterClause(filters: RunFilters): {
  whereSql: string;
  params: unknown[];
} {
  const conditions: string[] = [];
  const params: unknown[] = [];
  const push = (column: string, value: string | null | undefined) => {
    if (value === undefined || value === null || value === "") {
      return;
    }
    params.push(value);
    conditions.push(`${column} = $${params.length}`);
  };
  push("status", filters.status);
  push("preset", filters.preset);
  push("preset_id", filters.presetId);
  push("trigger", filters.trigger);
  push("suite_fingerprint", filters.suiteFingerprint);
  return {
    whereSql: conditions.length ? `where ${conditions.join(" and ")}` : "",
    params,
  };
}

type UnknownRecord = Record<string, unknown>;

function asNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function asBooleanOrNull(value: unknown): boolean | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    return value === "true" || value === "t" || value === "1";
  }
  return null;
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asIsoTimestamp(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "string") {
    return value;
  }
  return String(value ?? "");
}

function asIsoTimestampOrNull(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return asIsoTimestamp(value);
}

function asJson<T = JsonValue>(value: unknown): T | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    if (!value.trim()) {
      return undefined;
    }
    try {
      return JSON.parse(value) as T;
    } catch {
      return undefined;
    }
  }
  return value as T;
}

function mapRunSummaryRow(row: UnknownRecord): RunSummary {
  return {
    runId: String(row.id),
    status: String(row.status ?? ""),
    passed: asBooleanOrNull(row.passed),
    exitCode: asNumberOrNull(row.exit_code),
    preset: asStringOrNull(row.preset),
    label: asStringOrNull(row.label),
    notes: asStringOrNull(row.notes),
    trigger: asStringOrNull(row.trigger),
    cancelledAt: asIsoTimestampOrNull(row.cancelled_at),
    presetId: asStringOrNull(row.preset_id),
    startedAt: asIsoTimestamp(row.started_at),
    completedAt: asIsoTimestampOrNull(row.completed_at),
    suiteFingerprint: asStringOrNull(row.suite_fingerprint),
    finalError: asJson<Record<string, JsonValue>>(row.final_error_json) ?? null,
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

function mapScenarioRow(
  row: UnknownRecord,
  turns: UnknownRecord[],
  targetEvents: UnknownRecord[],
  toolCalls: UnknownRecord[],
  checkpoints: UnknownRecord[],
  judgeDimensionScores: UnknownRecord[],
): ScenarioRecord {
  const failureKindRaw = asStringOrNull(row.failure_kind);
  const failureKind =
    failureKindRaw === "harness" || failureKindRaw === "agent"
      ? failureKindRaw
      : null;
  return {
    scenarioRunId: Number(row.id),
    ordinal: Number(row.ordinal),
    scenarioId: String(row.scenario_id),
    scenarioName: String(row.scenario_name),
    personaId: String(row.persona_id),
    rubricId: String(row.rubric_id),
    userId: asStringOrNull(row.user_id),
    tags: asJson<JsonValue>(row.tags_json),
    priority: asStringOrNull(row.priority),
    expectations: asJson<JsonValue>(row.expectations_json),
    scenarioSnapshot: asJson<JsonValue>(row.scenario_snapshot_json),
    personaSnapshot: asJson<JsonValue>(row.persona_snapshot_json),
    rubricSnapshot: asJson<JsonValue>(row.rubric_snapshot_json),
    status: String(row.status ?? ""),
    passed: asBooleanOrNull(row.passed),
    failureKind,
    overallScore: asNumberOrNull(row.overall_score),
    passThreshold: asNumberOrNull(row.pass_threshold),
    judge: {
      provider: asStringOrNull(row.judge_provider),
      model: asStringOrNull(row.judge_model),
      temperature: asNumberOrNull(row.judge_temperature),
      maxTokens: asNumberOrNull(row.judge_max_tokens),
      overallNotes: asStringOrNull(row.overall_notes),
      output: asJson<JsonValue>(row.judge_output_json),
    },
    counts: {
      turnCount: Number(row.turn_count ?? 0),
      assistantTurnCount: Number(row.assistant_turn_count ?? 0),
      toolCallCount: Number(row.tool_call_count ?? 0),
      checkpointCount: Number(row.checkpoint_count ?? 0),
    },
    turns: turns.map((turn) => ({
      turn_index: Number(turn.turn_index),
      role: String(turn.role ?? ""),
      source: String(turn.source ?? ""),
      content: asStringOrNull(turn.content),
      generator_model: asStringOrNull(turn.generator_model),
      latency_ms: asNumberOrNull(turn.latency_ms),
      usage: asJson<JsonValue>(turn.usage_json) ?? null,
      created_at: asIsoTimestamp(turn.created_at),
    })),
    targetEvents: targetEvents.map((event) => ({
      turn_index: Number(event.turn_index),
      exchange_index: Number(event.exchange_index),
      raw_exchange: asJson<JsonValue>(event.raw_exchange_json) ?? null,
      latency_ms: asNumberOrNull(event.latency_ms),
      usage: asJson<JsonValue>(event.usage_json) ?? null,
    })),
    toolCalls: toolCalls.map((call) => ({
      turn_index: Number(call.turn_index),
      call_order: asNumberOrNull(call.call_order),
      name: String(call.name ?? ""),
      args: asJson<JsonValue>(call.args_json) ?? {},
      raw: asJson<JsonValue>(call.raw_json) ?? null,
    })),
    checkpoints: checkpoints.map((checkpoint) => ({
      checkpoint_index: Number(checkpoint.checkpoint_index),
      preceding_turn_index: asNumberOrNull(checkpoint.preceding_turn_index),
      passed: Boolean(checkpoint.passed),
      failures: asJson<JsonValue>(checkpoint.failures_json) ?? [],
      assertions: asJson<JsonValue>(checkpoint.assertions_json) ?? [],
    })),
    judgeDimensionScores: judgeDimensionScores.map((score) => ({
      dimension_id: String(score.dimension_id),
      dimension_name: String(score.dimension_name),
      weight: Number(score.weight),
      scale_type: String(score.scale_type),
      scale_points: asNumberOrNull(score.scale_points),
      raw_score: Number(score.raw_score),
      normalized_score: Number(score.normalized_score),
      reasoning: String(score.reasoning ?? ""),
      evidence: asJson<JsonValue>(score.evidence_json) ?? [],
    })),
    error: asJson<Record<string, JsonValue>>(row.error_json) ?? null,
    startedAt: asIsoTimestamp(row.started_at),
    completedAt: asIsoTimestampOrNull(row.completed_at),
  };
}

async function loadScenarioRecords(
  sql: SqlTag,
  runId: string,
  options: GetRunOptions = {},
): Promise<ScenarioRecord[]> {
  const ordinalFilter = options.ordinal;
  const isHttpScope = options.summary === true || ordinalFilter !== undefined;
  const columnList = isHttpScope
    ? sql.unsafe(SCENARIO_RUN_HTTP_COLUMNS)
    : sql.unsafe("*");
  const scenarioRows =
    ordinalFilter === undefined
      ? await span(
          "pg.scenario_runs",
          () => sql<UnknownRecord>`
            select ${columnList} from scenario_runs
            where run_id = ${runId} order by ordinal asc
          `,
        )
      : await span(
          "pg.scenario_runs",
          () => sql<UnknownRecord>`
            select ${columnList} from scenario_runs
            where run_id = ${runId} and ordinal = ${ordinalFilter}
            limit 1
          `,
        );
  const ids = scenarioRows.map((row) => Number(row.id));
  if (ids.length === 0) {
    return [];
  }

  if (options.summary) {
    return scenarioRows.map((row) => mapScenarioRow(row, [], [], [], [], []));
  }

  const [turns, events, toolCalls, checkpoints, dimensionScores] = await span(
    "pg.scenario_children",
    () =>
      Promise.all([
        span(
          "pg.turns",
          () => sql<UnknownRecord>`
            select * from turns where scenario_run_id in ${sql(ids)}
            order by scenario_run_id asc, turn_index asc
          `,
        ),
        span(
          "pg.target_events",
          () => sql<UnknownRecord>`
            select * from target_events where scenario_run_id in ${sql(ids)}
            order by scenario_run_id asc, turn_index asc, exchange_index asc
          `,
        ),
        span(
          "pg.tool_calls",
          () => sql<UnknownRecord>`
            select * from tool_calls where scenario_run_id in ${sql(ids)}
            order by scenario_run_id asc, turn_index asc, call_order asc nulls last
          `,
        ),
        span(
          "pg.checkpoints",
          () => sql<UnknownRecord>`
            select * from checkpoints where scenario_run_id in ${sql(ids)}
            order by scenario_run_id asc, checkpoint_index asc
          `,
        ),
        span(
          "pg.judge_dimension_scores",
          () => sql<UnknownRecord>`
            select * from judge_dimension_scores where scenario_run_id in ${sql(ids)}
            order by scenario_run_id asc, dimension_id asc
          `,
        ),
      ]),
  );

  const groupBy = <T extends UnknownRecord>(
    rows: T[],
    key: string,
  ): Map<number, T[]> => {
    const out = new Map<number, T[]>();
    for (const row of rows) {
      const id = Number(row[key]);
      const bucket = out.get(id) ?? [];
      bucket.push(row);
      out.set(id, bucket);
    }
    return out;
  };
  const turnsByScenario = groupBy(turns, "scenario_run_id");
  const eventsByScenario = groupBy(events, "scenario_run_id");
  const toolsByScenario = groupBy(toolCalls, "scenario_run_id");
  const checkpointsByScenario = groupBy(checkpoints, "scenario_run_id");
  const dimensionsByScenario = groupBy(dimensionScores, "scenario_run_id");

  return scenarioRows.map((row) =>
    mapScenarioRow(
      row,
      turnsByScenario.get(Number(row.id)) ?? [],
      eventsByScenario.get(Number(row.id)) ?? [],
      toolsByScenario.get(Number(row.id)) ?? [],
      checkpointsByScenario.get(Number(row.id)) ?? [],
      dimensionsByScenario.get(Number(row.id)) ?? [],
    ),
  );
}

async function readPresetSelection(
  sql: SqlTag,
  presetId: string,
): Promise<ScenarioSelectionRef[]> {
  const rows = await sql<UnknownRecord>`
    select file, scenario_id from preset_scenarios
    where preset_id = ${presetId}
    order by position asc
  `;
  return rows.map((row) => ({
    file: String(row.file),
    id: String(row.scenario_id),
  }));
}

async function readPresetSelections(
  sql: SqlTag,
  presetIds: string[],
): Promise<Map<string, ScenarioSelectionRef[]>> {
  const selections = new Map<string, ScenarioSelectionRef[]>(
    presetIds.map((id) => [id, []]),
  );
  if (presetIds.length === 0) {
    return selections;
  }

  const rows = await sql<UnknownRecord>`
    select preset_id, file, scenario_id from preset_scenarios
    where preset_id in ${sql(presetIds)}
    order by preset_id asc, position asc
  `;
  for (const row of rows) {
    const presetId = String(row.preset_id);
    const bucket = selections.get(presetId);
    if (!bucket) {
      continue;
    }
    bucket.push({
      file: String(row.file),
      id: String(row.scenario_id),
    });
  }
  return selections;
}

async function latestRunForPreset(
  sql: SqlTag,
  presetId: string,
): Promise<RunSummary | null> {
  const rows = await sql.unsafe<UnknownRecord>(
    `select ${RUN_SUMMARY_COLUMNS} from runs where preset_id = $1 order by started_at desc limit 1`,
    [presetId],
  );
  const row = rows[0];
  return row ? mapRunSummaryRow(row) : null;
}

async function latestRunsForPresets(
  sql: SqlTag,
  presetIds: string[],
): Promise<Map<string, RunSummary>> {
  const latestRuns = new Map<string, RunSummary>();
  if (presetIds.length === 0) {
    return latestRuns;
  }

  const rows = await sql<UnknownRecord>`
    select distinct on (preset_id) ${sql.unsafe(RUN_SUMMARY_COLUMNS)} from runs
    where preset_id in ${sql(presetIds)}
    order by preset_id asc, started_at desc
  `;
  for (const row of rows) {
    const presetId = asStringOrNull(row.preset_id);
    if (!presetId) {
      continue;
    }
    latestRuns.set(presetId, mapRunSummaryRow(row));
  }
  return latestRuns;
}

function mapPresetRow(
  row: UnknownRecord,
  selection: ScenarioSelectionRef[],
  lastRun: RunSummary | null,
): PresetRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    description: asStringOrNull(row.description),
    endpoint: String(row.endpoint),
    personas: String(row.personas),
    rubric: String(row.rubric),
    selection,
    parallel: {
      enabled: Boolean(row.parallel_enabled),
      limit:
        row.parallel_limit === null || row.parallel_limit === undefined
          ? null
          : Number(row.parallel_limit),
    },
    repeat: Number(row.repeat ?? 1),
    dryRun: Boolean(row.dry_run),
    createdAt: asIsoTimestamp(row.created_at),
    updatedAt: asIsoTimestamp(row.updated_at),
    deletedAt: asIsoTimestampOrNull(row.deleted_at),
    lastRun,
  };
}

async function fetchPresetById(
  sql: SqlTag,
  presetId: string,
  includeDeleted: boolean,
): Promise<PresetRecord | undefined> {
  const rows = includeDeleted
    ? await sql<UnknownRecord>`select * from presets where id = ${presetId}`
    : await sql<UnknownRecord>`
        select * from presets where id = ${presetId} and deleted_at is null
      `;
  const row = rows[0];
  if (!row) {
    return undefined;
  }
  const [selection, lastRun] = await Promise.all([
    readPresetSelection(sql, presetId),
    latestRunForPreset(sql, presetId),
  ]);
  return mapPresetRow(row, selection, lastRun);
}

/**
 * Postgres-backed repository. Bun.SQL is pool-backed, so each repository owns
 * one long-lived client and closes it during server shutdown.
 */
export class PostgresRepository implements RecordingRepository {
  readonly kind = "postgres" as const;
  readonly dbUrl: string;
  private sql?: SqlTag;

  constructor(dbUrl: string) {
    this.dbUrl = dbUrl;
  }

  async initialize(): Promise<void> {
    const report = await checkSchemaVersion(this.dbUrl);
    if (report.currentVersion < POSTGRES_TARGET_VERSION) {
      throw new AgentProbeConfigError(
        `Postgres schema version ${report.currentVersion} is behind expected ${POSTGRES_TARGET_VERSION} ` +
          `for ${report.dbUrl}. Run \`agentprobe db:migrate\` before starting the server.`,
      );
    }
    this.sql ??= createPostgresClient(this.dbUrl);
  }

  async close(): Promise<void> {
    const sql = this.sql;
    this.sql = undefined;
    await sql?.end?.();
  }

  createRecorder(): RunRecorder {
    return new PostgresRunRecorder(this.getSql());
  }

  private getSql(): SqlTag {
    this.sql ??= createPostgresClient(this.dbUrl);
    return this.sql;
  }

  private async withSql<T>(fn: (sql: SqlTag) => Promise<T>): Promise<T> {
    return await fn(this.getSql());
  }

  async createPreset(input: PresetWriteInput): Promise<PresetRecord> {
    return this.withSql(async (sql) => {
      const presetId = crypto.randomUUID().replaceAll("-", "");
      await sql.begin(async (tx) => {
        await tx`
          insert into presets (
            id, name, description, endpoint, personas, rubric,
            parallel_enabled, parallel_limit, repeat, dry_run, created_at, updated_at
          ) values (
            ${presetId},
            ${input.name},
            ${input.description ?? null},
            ${input.endpoint},
            ${input.personas},
            ${input.rubric},
            ${Boolean(input.parallel?.enabled)},
            ${input.parallel?.limit ?? null},
            ${input.repeat ?? 1},
            ${Boolean(input.dryRun)},
            now(),
            now()
          )
        `;
        await this.replacePresetScenarios(tx, presetId, input.selection);
      });
      const result = await fetchPresetById(sql, presetId, false);
      if (!result) {
        throw new AgentProbeRuntimeError(
          "Failed to read back inserted preset.",
        );
      }
      return result;
    });
  }

  async upsertPresetByName(input: PresetWriteInput): Promise<PresetRecord> {
    return this.withSql(async (sql) => {
      let presetId: string | undefined;
      await sql.begin(async (tx) => {
        const rows = await tx<UnknownRecord>`
          insert into presets (
            id, name, description, endpoint, personas, rubric,
            parallel_enabled, parallel_limit, repeat, dry_run, created_at, updated_at
          ) values (
            ${crypto.randomUUID().replaceAll("-", "")},
            ${input.name},
            ${input.description ?? null},
            ${input.endpoint},
            ${input.personas},
            ${input.rubric},
            ${Boolean(input.parallel?.enabled)},
            ${input.parallel?.limit ?? null},
            ${input.repeat ?? 1},
            ${Boolean(input.dryRun)},
            now(),
            now()
          )
          on conflict (name) do update set
            description = excluded.description,
            endpoint = excluded.endpoint,
            personas = excluded.personas,
            rubric = excluded.rubric,
            parallel_enabled = excluded.parallel_enabled,
            parallel_limit = excluded.parallel_limit,
            repeat = excluded.repeat,
            dry_run = excluded.dry_run,
            updated_at = now(),
            deleted_at = null
          returning id
        `;
        presetId = asStringOrNull(rows[0]?.id) ?? undefined;
        if (!presetId) {
          throw new AgentProbeRuntimeError(
            "Failed to read upserted preset id.",
          );
        }
        await this.replacePresetScenarios(tx, presetId, input.selection);
      });
      const result = presetId
        ? await fetchPresetById(sql, presetId, false)
        : undefined;
      if (!result) {
        throw new AgentProbeRuntimeError(
          "Failed to read back upserted preset.",
        );
      }
      return result;
    });
  }

  private async replacePresetScenarios(
    sql: SqlTag,
    presetId: string,
    selection: ScenarioSelectionRef[],
  ): Promise<void> {
    await sql`delete from preset_scenarios where preset_id = ${presetId}`;
    for (let index = 0; index < selection.length; index += 1) {
      const item = selection[index];
      if (!item) continue;
      await sql`
        insert into preset_scenarios (preset_id, file, scenario_id, position)
        values (${presetId}, ${item.file}, ${item.id}, ${index})
      `;
    }
  }

  async getPreset(
    presetId: string,
    options: { includeDeleted?: boolean } = {},
  ): Promise<PresetRecord | undefined> {
    return this.withSql((sql) =>
      fetchPresetById(sql, presetId, Boolean(options.includeDeleted)),
    );
  }

  async listPresets(
    options: { includeDeleted?: boolean } = {},
  ): Promise<PresetRecord[]> {
    return this.withSql(async (sql) => {
      const rows = options.includeDeleted
        ? await sql<UnknownRecord>`select * from presets order by updated_at desc`
        : await sql<UnknownRecord>`
            select * from presets where deleted_at is null order by updated_at desc
          `;
      const presetIds = rows.map((row) => String(row.id));
      const [selectionsByPreset, latestRunsByPreset] = await Promise.all([
        readPresetSelections(sql, presetIds),
        latestRunsForPresets(sql, presetIds),
      ]);
      return rows.map((row) => {
        const presetId = String(row.id);
        return mapPresetRow(
          row,
          selectionsByPreset.get(presetId) ?? [],
          latestRunsByPreset.get(presetId) ?? null,
        );
      });
    });
  }

  async updatePreset(
    presetId: string,
    input: Partial<PresetWriteInput>,
  ): Promise<PresetRecord | undefined> {
    return this.withSql(async (sql) => {
      const existing = await fetchPresetById(sql, presetId, false);
      if (!existing) {
        return undefined;
      }
      const merged = {
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
      await sql.begin(async (tx) => {
        await tx`
          update presets set
            name = ${merged.name},
            description = ${merged.description ?? null},
            endpoint = ${merged.endpoint},
            personas = ${merged.personas},
            rubric = ${merged.rubric},
            parallel_enabled = ${Boolean(merged.parallel?.enabled)},
            parallel_limit = ${merged.parallel?.limit ?? null},
            repeat = ${merged.repeat ?? 1},
            dry_run = ${Boolean(merged.dryRun)},
            updated_at = now()
          where id = ${presetId} and deleted_at is null
        `;
        await this.replacePresetScenarios(tx, presetId, merged.selection);
      });
      return fetchPresetById(sql, presetId, false);
    });
  }

  async softDeletePreset(presetId: string): Promise<PresetRecord | undefined> {
    return this.withSql(async (sql) => {
      await sql`
        update presets set deleted_at = now(), updated_at = now()
        where id = ${presetId} and deleted_at is null
      `;
      return fetchPresetById(sql, presetId, true);
    });
  }

  async listRuns(options: ListRunsOptions = {}): Promise<RunSummary[]> {
    return this.withSql(async (sql) => {
      const { whereSql, params } = buildRunFilterClause(options);
      const limit =
        options.limit !== undefined && options.limit > 0
          ? Math.min(options.limit, MAX_LIST_RUNS_LIMIT)
          : null;
      const offset =
        options.offset !== undefined && options.offset > 0 ? options.offset : 0;
      let limitClause = "";
      const finalParams = [...params];
      if (limit !== null) {
        finalParams.push(limit, offset);
        limitClause = ` limit $${finalParams.length - 1} offset $${finalParams.length}`;
      }
      const query = `select ${RUN_SUMMARY_COLUMNS} from runs ${whereSql} order by started_at desc${limitClause}`;
      const rows = await sql.unsafe<UnknownRecord>(query, finalParams);
      return rows.map(mapRunSummaryRow);
    });
  }

  async countRuns(filters: RunFilters = {}): Promise<number> {
    return this.withSql(async (sql) => {
      const { whereSql, params } = buildRunFilterClause(filters);
      const query = `select count(*)::bigint as count from runs ${whereSql}`;
      const rows = await sql.unsafe<{ count: number | string | bigint }>(
        query,
        params,
      );
      return Number(rows[0]?.count ?? 0);
    });
  }

  async listRunsForPreset(presetId: string): Promise<RunSummary[]> {
    return this.withSql(async (sql) => {
      const rows = await sql.unsafe<UnknownRecord>(
        `select ${RUN_SUMMARY_COLUMNS} from runs where preset_id = $1 order by started_at desc`,
        [presetId],
      );
      return rows.map(mapRunSummaryRow);
    });
  }

  async getRun(
    runId: string,
    options: GetRunOptions = {},
  ): Promise<RunRecord | undefined> {
    return this.withSql(async (sql) => {
      const rows = await span(
        "pg.runs",
        () => sql<UnknownRecord>`
          select * from runs where id = ${runId} limit 1
        `,
      );
      const row = rows[0];
      if (!row) {
        return undefined;
      }
      const summary = mapRunSummaryRow(row);
      const scenarios = await loadScenarioRecords(sql, runId, options);
      return await span("getRun.assemble", () => ({
        ...summary,
        sourcePaths:
          asJson<Record<string, string>>(row.source_paths_json) ?? null,
        endpointSnapshot:
          asJson<Record<string, JsonValue>>(row.endpoint_snapshot_json) ?? null,
        selectedScenarioIds:
          asJson<string[]>(row.selected_scenario_ids_json) ?? null,
        presetSnapshot:
          asJson<Record<string, JsonValue>>(row.preset_snapshot_json) ?? null,
        scenarios,
      }));
    });
  }

  async latestRunForSuite(
    suiteFingerprint: string,
    options: { beforeStartedAt?: string } = {},
  ): Promise<RunRecord | undefined> {
    return this.withSql(async (sql) => {
      const cutoff = options.beforeStartedAt ?? null;
      const rows = cutoff
        ? await sql<UnknownRecord>`
            select id from runs
            where suite_fingerprint = ${suiteFingerprint}
              and started_at < ${cutoff}
            order by started_at desc limit 1
          `
        : await sql<UnknownRecord>`
            select id from runs where suite_fingerprint = ${suiteFingerprint}
            order by started_at desc limit 1
          `;
      const runId = rows[0]?.id;
      if (!runId) {
        return undefined;
      }
      return this.getRun(String(runId));
    });
  }

  async markRunCancelled(
    runId: string,
    options: { exitCode?: number } = {},
  ): Promise<RunRecord | undefined> {
    return this.withSql(async (sql) => {
      await sql`
        update runs set
          status = 'cancelled',
          passed = false,
          exit_code = ${options.exitCode ?? 130},
          cancelled_at = now(),
          completed_at = coalesce(completed_at, now()),
          updated_at = now()
        where id = ${runId}
      `;
      return this.getRun(runId);
    });
  }

  async updateRunMetadata(
    runId: string,
    patch: { label?: string | null; notes?: string | null },
  ): Promise<RunRecord | undefined> {
    return this.withSql(async (sql) => {
      const exists = await sql<UnknownRecord>`
        select 1 from runs where id = ${runId}
      `;
      if (exists.length === 0) {
        return undefined;
      }
      const hasLabel = Object.hasOwn(patch, "label");
      const hasNotes = Object.hasOwn(patch, "notes");
      if (!hasLabel && !hasNotes) {
        return this.getRun(runId);
      }
      if (hasLabel && hasNotes) {
        await sql`
          update runs set
            label = ${patch.label ?? null},
            notes = ${patch.notes ?? null},
            updated_at = now()
          where id = ${runId}
        `;
      } else if (hasLabel) {
        await sql`
          update runs set
            label = ${patch.label ?? null},
            updated_at = now()
          where id = ${runId}
        `;
      } else {
        await sql`
          update runs set
            notes = ${patch.notes ?? null},
            updated_at = now()
          where id = ${runId}
        `;
      }
      return this.getRun(runId);
    });
  }

  async getSecret(key: string): Promise<StoredSecretEnvelope | undefined> {
    return this.withSql(async (sql) => {
      const rows = await sql<UnknownRecord>`
        select ciphertext, iv, auth_tag from app_settings where key = ${key}
      `;
      const row = rows[0];
      if (!row) {
        return undefined;
      }
      return {
        ciphertext: String(row.ciphertext),
        iv: String(row.iv),
        authTag: String(row.auth_tag),
      };
    });
  }

  async putSecret(key: string, secret: StoredSecretEnvelope): Promise<void> {
    await this.withSql(async (sql) => {
      await sql`
        insert into app_settings (key, ciphertext, iv, auth_tag, updated_at)
        values (${key}, ${secret.ciphertext}, ${secret.iv}, ${secret.authTag}, now())
        on conflict (key) do update set
          ciphertext = excluded.ciphertext,
          iv = excluded.iv,
          auth_tag = excluded.auth_tag,
          updated_at = excluded.updated_at
      `;
    });
  }

  async deleteSecret(key: string): Promise<boolean> {
    return this.withSql(async (sql) => {
      const rows = await sql<UnknownRecord>`
        delete from app_settings where key = ${key} returning key
      `;
      return rows.length > 0;
    });
  }

  async getEndpointOverride(
    endpointPath: string,
  ): Promise<StoredEndpointOverride | undefined> {
    return this.withSql(async (sql) => {
      const rows = await sql<UnknownRecord>`
        select endpoint_path, overrides_json, updated_at
        from endpoint_overrides
        where endpoint_path = ${endpointPath}
      `;
      const row = rows[0];
      if (!row) {
        return undefined;
      }
      return {
        endpointPath: String(row.endpoint_path),
        overrides: asJson<Record<string, unknown>>(row.overrides_json) ?? {},
        updatedAt: asIsoTimestamp(row.updated_at),
      };
    });
  }

  async listEndpointOverrides(): Promise<StoredEndpointOverride[]> {
    return this.withSql(async (sql) => {
      const rows = await sql<UnknownRecord>`
        select endpoint_path, overrides_json, updated_at
        from endpoint_overrides
        order by endpoint_path
      `;
      return rows.map((row) => ({
        endpointPath: String(row.endpoint_path),
        overrides: asJson<Record<string, unknown>>(row.overrides_json) ?? {},
        updatedAt: asIsoTimestamp(row.updated_at),
      }));
    });
  }

  async putEndpointOverride(
    endpointPath: string,
    overrides: Record<string, unknown>,
  ): Promise<StoredEndpointOverride> {
    return this.withSql(async (sql) => {
      const rows = await sql<UnknownRecord>`
        insert into endpoint_overrides (
          endpoint_path, overrides_json, updated_at
        ) values (
          ${endpointPath}, ${JSON.stringify(overrides)}::jsonb, now()
        )
        on conflict (endpoint_path) do update set
          overrides_json = excluded.overrides_json,
          updated_at = excluded.updated_at
        returning endpoint_path, overrides_json, updated_at
      `;
      const row = rows[0];
      if (!row) {
        throw new AgentProbeRuntimeError(
          "Failed to read back endpoint override.",
        );
      }
      return {
        endpointPath: String(row.endpoint_path),
        overrides: asJson<Record<string, unknown>>(row.overrides_json) ?? {},
        updatedAt: asIsoTimestamp(row.updated_at),
      };
    });
  }

  async deleteEndpointOverride(endpointPath: string): Promise<boolean> {
    return this.withSql(async (sql) => {
      const rows = await sql<UnknownRecord>`
        delete from endpoint_overrides
        where endpoint_path = ${endpointPath}
        returning endpoint_path
      `;
      return rows.length > 0;
    });
  }

  async listHumanScoringRubrics(): Promise<HumanScoringRubricSummary[]> {
    return this.withSql(async (sql) => {
      const totals = await sql<UnknownRecord>`
        select rubric_id, count(*)::int as total
        from scenario_runs
        where status = 'completed'
        group by rubric_id
      `;
      if (totals.length === 0) {
        return [];
      }

      const snapshots = await sql<UnknownRecord>`
        select distinct on (rubric_id) rubric_id, rubric_snapshot_json
        from scenario_runs
        where status = 'completed' and rubric_snapshot_json is not null
        order by rubric_id, started_at desc
      `;
      const snapshotByRubric = new Map<string, RubricSnapshotShape>();
      for (const row of snapshots) {
        const snap = asJson<RubricSnapshotShape>(row.rubric_snapshot_json);
        if (snap && Array.isArray(snap.dimensions)) {
          snapshotByRubric.set(String(row.rubric_id), snap);
        }
      }

      const scoredRows = await sql<UnknownRecord>`
        select sr.rubric_id, hds.dimension_id, count(*)::int as scored
        from human_dimension_scores hds
        join scenario_runs sr on sr.id = hds.scenario_run_id
        where sr.status = 'completed'
        group by sr.rubric_id, hds.dimension_id
      `;
      const scoredCounts = new Map<string, number>();
      for (const row of scoredRows) {
        scoredCounts.set(
          `${String(row.rubric_id)}::${String(row.dimension_id)}`,
          Number(row.scored),
        );
      }

      const pairedRows = await sql<UnknownRecord>`
        select sr.rubric_id, hds.dimension_id,
               hds.normalized_score as human_norm,
               jds.normalized_score as judge_norm
        from human_dimension_scores hds
        join scenario_runs sr on sr.id = hds.scenario_run_id
        join judge_dimension_scores jds
          on jds.scenario_run_id = hds.scenario_run_id
          and jds.dimension_id = hds.dimension_id
        where sr.status = 'completed'
      `;
      const paired = new Map<string, { xs: number[]; ys: number[] }>();
      for (const row of pairedRows) {
        const key = `${String(row.rubric_id)}::${String(row.dimension_id)}`;
        let bucket = paired.get(key);
        if (!bucket) {
          bucket = { xs: [], ys: [] };
          paired.set(key, bucket);
        }
        bucket.xs.push(Number(row.human_norm));
        bucket.ys.push(Number(row.judge_norm));
      }

      const result: HumanScoringRubricSummary[] = [];
      for (const row of totals) {
        const rubricId = String(row.rubric_id);
        const totalScenarios = Number(row.total);
        const snap = snapshotByRubric.get(rubricId);
        if (!snap || !Array.isArray(snap.dimensions)) {
          continue;
        }
        result.push({
          rubricId,
          rubricName: snap.name ?? rubricId,
          totalScenarios,
          dimensions: snap.dimensions.map((dim) => {
            const scored = scoredCounts.get(`${rubricId}::${dim.id}`) ?? 0;
            const bucket = paired.get(`${rubricId}::${dim.id}`);
            const correlationResult = bucket
              ? pearsonCorrelation(bucket.xs, bucket.ys)
              : { value: null, n: 0 };
            return {
              id: dim.id,
              name: dim.name,
              weight: dim.weight,
              scale:
                dim.scale as HumanScoringRubricSummary["dimensions"][number]["scale"],
              unscored: Math.max(0, totalScenarios - scored),
              pairedCount: correlationResult.n,
              correlation: correlationResult.value,
            };
          }),
        });
      }
      result.sort((a, b) => a.rubricName.localeCompare(b.rubricName));
      return result;
    });
  }

  async getNextUnscoredScenario(
    rubricId: string,
    dimensionId: string,
  ): Promise<HumanScoringQueueItem | null> {
    return this.withSql(async (sql) => {
      const remainingRows = await sql<UnknownRecord>`
        select count(*)::int as remaining
        from scenario_runs sr
        left join human_dimension_scores hds
          on hds.scenario_run_id = sr.id
          and hds.dimension_id = ${dimensionId}
        where sr.status = 'completed'
          and sr.rubric_id = ${rubricId}
          and hds.id is null
      `;
      const remaining = Number(remainingRows[0]?.remaining ?? 0);
      if (remaining === 0) {
        return null;
      }

      const rows = await sql<UnknownRecord>`
        select sr.id as scenario_run_id, sr.run_id, sr.ordinal,
               sr.scenario_id, sr.scenario_name, sr.persona_id, sr.rubric_id,
               sr.pass_threshold, sr.overall_score, sr.expectations_json,
               sr.scenario_snapshot_json
        from scenario_runs sr
        left join human_dimension_scores hds
          on hds.scenario_run_id = sr.id
          and hds.dimension_id = ${dimensionId}
        where sr.status = 'completed'
          and sr.rubric_id = ${rubricId}
          and hds.id is null
        order by sr.started_at asc, sr.id asc
        limit 1
      `;
      const row = rows[0];
      if (!row) {
        return null;
      }
      const scenarioRunId = Number(row.scenario_run_id);

      const turnRows = await sql<UnknownRecord>`
        select turn_index, role, source, content, generator_model
        from turns
        where scenario_run_id = ${scenarioRunId}
        order by turn_index asc
      `;
      const turns = turnRows.map((turn) => ({
        turn_index: Number(turn.turn_index),
        role: typeof turn.role === "string" ? turn.role : null,
        source: typeof turn.source === "string" ? turn.source : null,
        content: typeof turn.content === "string" ? turn.content : null,
        generator_model:
          typeof turn.generator_model === "string"
            ? turn.generator_model
            : null,
      })) satisfies Array<Record<string, JsonValue>>;

      const toolCallRows = await sql<UnknownRecord>`
        select turn_index, call_order, name, args_json, raw_json
        from tool_calls
        where scenario_run_id = ${scenarioRunId}
        order by turn_index asc, call_order asc
      `;
      const toolCalls = toolCallRows.map((call) => ({
        turn_index: Number(call.turn_index),
        call_order:
          call.call_order === null || call.call_order === undefined
            ? null
            : Number(call.call_order),
        name: typeof call.name === "string" ? call.name : null,
        args: asJson<JsonValue>(call.args_json) ?? null,
        raw: asJson<JsonValue>(call.raw_json) ?? null,
      })) satisfies Array<Record<string, JsonValue>>;

      const targetEventRows = await sql<UnknownRecord>`
        select turn_index, exchange_index, raw_exchange_json, latency_ms, usage_json
        from target_events
        where scenario_run_id = ${scenarioRunId}
        order by turn_index asc, exchange_index asc
      `;
      const targetEvents = targetEventRows.map((event) => ({
        turn_index: Number(event.turn_index),
        exchange_index: Number(event.exchange_index),
        raw_exchange: asJson<JsonValue>(event.raw_exchange_json) ?? null,
        latency_ms:
          event.latency_ms === null || event.latency_ms === undefined
            ? null
            : Number(event.latency_ms),
        usage: asJson<JsonValue>(event.usage_json) ?? null,
      })) satisfies Array<Record<string, JsonValue>>;

      const judgeRows = await sql<UnknownRecord>`
        select raw_score, normalized_score
        from judge_dimension_scores
        where scenario_run_id = ${scenarioRunId}
          and dimension_id = ${dimensionId}
        limit 1
      `;
      const judgeRow = judgeRows[0];

      return {
        scenarioRunId,
        runId: String(row.run_id),
        ordinal: Number(row.ordinal),
        scenarioId: String(row.scenario_id),
        scenarioName: String(row.scenario_name),
        personaId: String(row.persona_id),
        rubricId: String(row.rubric_id),
        passThreshold:
          row.pass_threshold === null || row.pass_threshold === undefined
            ? null
            : Number(row.pass_threshold),
        overallScore:
          row.overall_score === null || row.overall_score === undefined
            ? null
            : Number(row.overall_score),
        judgeDimensionScore:
          judgeRow && judgeRow.normalized_score !== null
            ? Number(judgeRow.normalized_score)
            : null,
        judgeDimensionRawScore:
          judgeRow && judgeRow.raw_score !== null
            ? Number(judgeRow.raw_score)
            : null,
        scenarioDescription: (() => {
          const snapshot = asJson<Record<string, JsonValue>>(
            row.scenario_snapshot_json,
          );
          const description = snapshot?.description;
          return typeof description === "string" && description.trim()
            ? description.trim()
            : null;
        })(),
        expectations: asJson<JsonValue>(row.expectations_json) ?? null,
        turns,
        toolCalls,
        targetEvents,
        remaining,
      };
    });
  }

  async recordHumanScore(input: HumanScoreInput): Promise<void> {
    const normalized = normalizeHumanScore(
      input.rawScore,
      input.scaleType,
      input.scalePoints,
    );
    return this.withSql(async (sql) => {
      await sql`
        insert into human_dimension_scores (
          scenario_run_id, dimension_id, dimension_name,
          scale_type, scale_points, raw_score, normalized_score, created_at
        ) values (
          ${input.scenarioRunId}, ${input.dimensionId}, ${input.dimensionName},
          ${input.scaleType}, ${input.scalePoints ?? null},
          ${input.rawScore}, ${normalized}, now()
        )
        on conflict (scenario_run_id, dimension_id) do update set
          dimension_name = excluded.dimension_name,
          scale_type = excluded.scale_type,
          scale_points = excluded.scale_points,
          raw_score = excluded.raw_score,
          normalized_score = excluded.normalized_score,
          created_at = excluded.created_at
      `;
    });
  }
}

type RubricSnapshotShape = {
  id?: string;
  name?: string;
  passThreshold?: number;
  dimensions?: Array<{
    id: string;
    name: string;
    weight: number;
    scale: { type: string; points?: number; labels: Record<string, string> };
  }>;
};

function normalizeHumanScore(
  rawScore: number,
  scaleType: string,
  scalePoints?: number | null,
): number {
  if (scaleType === "binary") {
    return rawScore >= 1 ? 1 : 0;
  }
  const points =
    typeof scalePoints === "number" && scalePoints > 0 ? scalePoints : 1;
  return rawScore / points;
}

function pearsonCorrelation(
  xs: number[],
  ys: number[],
): { value: number | null; n: number } {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) {
    return { value: null, n };
  }
  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < n; i += 1) {
    sumX += xs[i] ?? 0;
    sumY += ys[i] ?? 0;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;
  let cov = 0;
  let varX = 0;
  let varY = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = (xs[i] ?? 0) - meanX;
    const dy = (ys[i] ?? 0) - meanY;
    cov += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }
  if (varX === 0 || varY === 0) {
    return { value: null, n };
  }
  return { value: cov / Math.sqrt(varX * varY), n };
}

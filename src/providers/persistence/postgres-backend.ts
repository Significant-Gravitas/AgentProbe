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
import { createPostgresClient, type SqlTag } from "./postgres-client.ts";
import type {
  PersistenceRepository,
  PresetWriteInput,
  RunRecorder,
} from "./types.ts";

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
): Promise<ScenarioRecord[]> {
  const scenarioRows = await sql<UnknownRecord>`
    select * from scenario_runs where run_id = ${runId} order by ordinal asc
  `;
  const ids = scenarioRows.map((row) => Number(row.id));
  if (ids.length === 0) {
    return [];
  }
  const [turns, events, toolCalls, checkpoints, dimensionScores] =
    await Promise.all([
      sql<UnknownRecord>`
        select * from turns where scenario_run_id in ${sql(ids)}
        order by scenario_run_id asc, turn_index asc
      `,
      sql<UnknownRecord>`
        select * from target_events where scenario_run_id in ${sql(ids)}
        order by scenario_run_id asc, turn_index asc, exchange_index asc
      `,
      sql<UnknownRecord>`
        select * from tool_calls where scenario_run_id in ${sql(ids)}
        order by scenario_run_id asc, turn_index asc, call_order asc nulls last
      `,
      sql<UnknownRecord>`
        select * from checkpoints where scenario_run_id in ${sql(ids)}
        order by scenario_run_id asc, checkpoint_index asc
      `,
      sql<UnknownRecord>`
        select * from judge_dimension_scores where scenario_run_id in ${sql(ids)}
        order by scenario_run_id asc, dimension_id asc
      `,
    ]);

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
  const rows = await sql<UnknownRecord>`
    select * from runs where preset_id = ${presetId}
    order by started_at desc limit 1
  `;
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
    select distinct on (preset_id) * from runs
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
 * Postgres-backed repository. Reads are fully implemented; the recorder
 * (writes) is deferred until a buffered async recorder ships in a follow-up
 * (tracked as a separate issue). Preset CRUD works because it is inherently
 * async already on Postgres.
 */
export class PostgresRepository implements PersistenceRepository {
  readonly kind = "postgres" as const;
  readonly dbUrl: string;

  constructor(dbUrl: string) {
    this.dbUrl = dbUrl;
  }

  createRecorder(): RunRecorder {
    throw new AgentProbeConfigError(
      "Recording runs against Postgres is not enabled in this release. " +
        "Use a `sqlite:///` URL for run recording; Postgres currently supports " +
        "schema migrations, preset CRUD, and historical reads (comparison, listings).",
    );
  }

  private async withSql<T>(fn: (sql: SqlTag) => Promise<T>): Promise<T> {
    const sql = createPostgresClient(this.dbUrl);
    try {
      return await fn(sql);
    } finally {
      await sql.end?.();
    }
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

  async listRuns(): Promise<RunSummary[]> {
    return this.withSql(async (sql) => {
      const rows = await sql<UnknownRecord>`
        select * from runs order by started_at desc
      `;
      return rows.map(mapRunSummaryRow);
    });
  }

  async listRunsForPreset(presetId: string): Promise<RunSummary[]> {
    return this.withSql(async (sql) => {
      const rows = await sql<UnknownRecord>`
        select * from runs where preset_id = ${presetId}
        order by started_at desc
      `;
      return rows.map(mapRunSummaryRow);
    });
  }

  async getRun(runId: string): Promise<RunRecord | undefined> {
    return this.withSql(async (sql) => {
      const rows = await sql<UnknownRecord>`
        select * from runs where id = ${runId} limit 1
      `;
      const row = rows[0];
      if (!row) {
        return undefined;
      }
      const summary = mapRunSummaryRow(row);
      const scenarios = await loadScenarioRecords(sql, runId);
      return {
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
      };
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
}

import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

export const sqliteMeta = sqliteTable("meta", {
  id: integer("id").primaryKey(),
  schemaVersion: integer("schema_version").notNull(),
  createdAt: text("created_at").notNull(),
});

export const sqliteRuns = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    status: text("status").notNull(),
    passed: integer("passed"),
    exitCode: integer("exit_code"),
    transport: text("transport"),
    preset: text("preset"),
    label: text("label"),
    notes: text("notes"),
    trigger: text("trigger").notNull().default("cli"),
    cancelledAt: text("cancelled_at"),
    presetId: text("preset_id"),
    presetSnapshotJson: text("preset_snapshot_json"),
    filtersJson: text("filters_json"),
    selectedScenarioIdsJson: text("selected_scenario_ids_json"),
    suiteFingerprint: text("suite_fingerprint"),
    sourcePathsJson: text("source_paths_json"),
    endpointConfigHash: text("endpoint_config_hash"),
    scenariosConfigHash: text("scenarios_config_hash"),
    personasConfigHash: text("personas_config_hash"),
    rubricConfigHash: text("rubric_config_hash"),
    endpointSnapshotJson: text("endpoint_snapshot_json"),
    scenarioTotal: integer("scenario_total").notNull().default(0),
    scenarioPassedCount: integer("scenario_passed_count").notNull().default(0),
    scenarioFailedCount: integer("scenario_failed_count").notNull().default(0),
    scenarioHarnessFailedCount: integer("scenario_harness_failed_count")
      .notNull()
      .default(0),
    scenarioErroredCount: integer("scenario_errored_count")
      .notNull()
      .default(0),
    finalErrorJson: text("final_error_json"),
    startedAt: text("started_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    completedAt: text("completed_at"),
  },
  (table) => [
    index("idx_runs_status").on(table.status),
    index("idx_runs_trigger").on(table.trigger),
    index("idx_runs_preset_id").on(table.presetId),
    index("idx_runs_started_at").on(table.startedAt),
  ],
);

export const sqliteScenarioRuns = sqliteTable(
  "scenario_runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: text("run_id")
      .notNull()
      .references(() => sqliteRuns.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    scenarioId: text("scenario_id").notNull(),
    scenarioName: text("scenario_name").notNull(),
    personaId: text("persona_id").notNull(),
    rubricId: text("rubric_id").notNull(),
    userId: text("user_id"),
    tagsJson: text("tags_json"),
    priority: text("priority"),
    expectationsJson: text("expectations_json"),
    scenarioSnapshotJson: text("scenario_snapshot_json"),
    personaSnapshotJson: text("persona_snapshot_json"),
    rubricSnapshotJson: text("rubric_snapshot_json"),
    status: text("status").notNull(),
    passed: integer("passed"),
    failureKind: text("failure_kind"),
    overallScore: real("overall_score"),
    passThreshold: real("pass_threshold"),
    judgeProvider: text("judge_provider"),
    judgeModel: text("judge_model"),
    judgeTemperature: real("judge_temperature"),
    judgeMaxTokens: integer("judge_max_tokens"),
    overallNotes: text("overall_notes"),
    judgeOutputJson: text("judge_output_json"),
    turnCount: integer("turn_count").notNull().default(0),
    assistantTurnCount: integer("assistant_turn_count").notNull().default(0),
    toolCallCount: integer("tool_call_count").notNull().default(0),
    checkpointCount: integer("checkpoint_count").notNull().default(0),
    errorJson: text("error_json"),
    startedAt: text("started_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    completedAt: text("completed_at"),
  },
  (table) => [
    index("idx_scenario_runs_run_id").on(table.runId),
    index("idx_scenario_runs_scenario_id").on(table.scenarioId),
  ],
);

export const sqliteTurns = sqliteTable("turns", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  scenarioRunId: integer("scenario_run_id")
    .notNull()
    .references(() => sqliteScenarioRuns.id, { onDelete: "cascade" }),
  turnIndex: integer("turn_index").notNull(),
  role: text("role").notNull(),
  source: text("source").notNull(),
  content: text("content"),
  generatorModel: text("generator_model"),
  latencyMs: real("latency_ms"),
  usageJson: text("usage_json"),
  createdAt: text("created_at").notNull(),
});

export const sqliteTargetEvents = sqliteTable("target_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  scenarioRunId: integer("scenario_run_id")
    .notNull()
    .references(() => sqliteScenarioRuns.id, { onDelete: "cascade" }),
  turnIndex: integer("turn_index").notNull(),
  exchangeIndex: integer("exchange_index").notNull(),
  rawExchangeJson: text("raw_exchange_json"),
  latencyMs: real("latency_ms"),
  usageJson: text("usage_json"),
  createdAt: text("created_at").notNull(),
});

export const sqliteToolCalls = sqliteTable("tool_calls", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  scenarioRunId: integer("scenario_run_id")
    .notNull()
    .references(() => sqliteScenarioRuns.id, { onDelete: "cascade" }),
  turnIndex: integer("turn_index").notNull(),
  callOrder: integer("call_order"),
  name: text("name").notNull(),
  argsJson: text("args_json"),
  rawJson: text("raw_json"),
  createdAt: text("created_at").notNull(),
});

export const sqliteCheckpoints = sqliteTable("checkpoints", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  scenarioRunId: integer("scenario_run_id")
    .notNull()
    .references(() => sqliteScenarioRuns.id, { onDelete: "cascade" }),
  checkpointIndex: integer("checkpoint_index").notNull(),
  precedingTurnIndex: integer("preceding_turn_index"),
  passed: integer("passed").notNull(),
  failuresJson: text("failures_json"),
  assertionsJson: text("assertions_json"),
  createdAt: text("created_at").notNull(),
});

export const sqliteJudgeDimensionScores = sqliteTable(
  "judge_dimension_scores",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    scenarioRunId: integer("scenario_run_id")
      .notNull()
      .references(() => sqliteScenarioRuns.id, { onDelete: "cascade" }),
    dimensionId: text("dimension_id").notNull(),
    dimensionName: text("dimension_name").notNull(),
    weight: real("weight").notNull(),
    scaleType: text("scale_type").notNull(),
    scalePoints: real("scale_points"),
    rawScore: real("raw_score").notNull(),
    normalizedScore: real("normalized_score").notNull(),
    reasoning: text("reasoning").notNull(),
    evidenceJson: text("evidence_json"),
    createdAt: text("created_at").notNull(),
  },
);

export const sqliteHumanDimensionScores = sqliteTable(
  "human_dimension_scores",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    scenarioRunId: integer("scenario_run_id")
      .notNull()
      .references(() => sqliteScenarioRuns.id, { onDelete: "cascade" }),
    dimensionId: text("dimension_id").notNull(),
    dimensionName: text("dimension_name").notNull(),
    scaleType: text("scale_type").notNull(),
    scalePoints: real("scale_points"),
    rawScore: real("raw_score").notNull(),
    normalizedScore: real("normalized_score").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("idx_human_dim_scores_scenario_run").on(table.scenarioRunId),
  ],
);

export const sqlitePresets = sqliteTable("presets", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  description: text("description"),
  endpoint: text("endpoint").notNull(),
  personas: text("personas").notNull(),
  rubric: text("rubric").notNull(),
  parallelEnabled: integer("parallel_enabled").notNull().default(0),
  parallelLimit: integer("parallel_limit"),
  repeat: integer("repeat").notNull().default(1),
  dryRun: integer("dry_run").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  deletedAt: text("deleted_at"),
});

export const sqlitePresetScenarios = sqliteTable(
  "preset_scenarios",
  {
    presetId: text("preset_id")
      .notNull()
      .references(() => sqlitePresets.id, { onDelete: "cascade" }),
    file: text("file").notNull(),
    scenarioId: text("scenario_id").notNull(),
    position: integer("position").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.presetId, table.file, table.scenarioId],
    }),
    index("idx_preset_scenarios_position").on(table.presetId, table.position),
  ],
);

export const sqliteAppSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  ciphertext: text("ciphertext").notNull(),
  iv: text("iv").notNull(),
  authTag: text("auth_tag").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const sqliteEndpointOverrides = sqliteTable("endpoint_overrides", {
  endpointPath: text("endpoint_path").primaryKey(),
  overridesJson: text("overrides_json").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const sqliteSchema = {
  meta: sqliteMeta,
  runs: sqliteRuns,
  scenarioRuns: sqliteScenarioRuns,
  turns: sqliteTurns,
  targetEvents: sqliteTargetEvents,
  toolCalls: sqliteToolCalls,
  checkpoints: sqliteCheckpoints,
  judgeDimensionScores: sqliteJudgeDimensionScores,
  humanDimensionScores: sqliteHumanDimensionScores,
  presets: sqlitePresets,
  presetScenarios: sqlitePresetScenarios,
  appSettings: sqliteAppSettings,
  endpointOverrides: sqliteEndpointOverrides,
};

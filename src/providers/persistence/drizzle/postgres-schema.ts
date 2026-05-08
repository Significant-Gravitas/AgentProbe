import {
  bigint,
  bigserial,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const postgresMeta = pgTable("meta", {
  id: integer("id").primaryKey(),
  schemaVersion: integer("schema_version").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const postgresRuns = pgTable(
  "runs",
  {
    id: text("id").primaryKey(),
    status: text("status").notNull(),
    passed: boolean("passed"),
    exitCode: integer("exit_code"),
    transport: text("transport"),
    preset: text("preset"),
    label: text("label"),
    notes: text("notes"),
    trigger: text("trigger").notNull().default("cli"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    presetId: text("preset_id"),
    presetSnapshotJson: jsonb("preset_snapshot_json"),
    filtersJson: jsonb("filters_json"),
    selectedScenarioIdsJson: jsonb("selected_scenario_ids_json"),
    suiteFingerprint: text("suite_fingerprint"),
    sourcePathsJson: jsonb("source_paths_json"),
    endpointConfigHash: text("endpoint_config_hash"),
    scenariosConfigHash: text("scenarios_config_hash"),
    personasConfigHash: text("personas_config_hash"),
    rubricConfigHash: text("rubric_config_hash"),
    endpointSnapshotJson: jsonb("endpoint_snapshot_json"),
    scenarioTotal: integer("scenario_total").notNull().default(0),
    scenarioPassedCount: integer("scenario_passed_count").notNull().default(0),
    scenarioFailedCount: integer("scenario_failed_count").notNull().default(0),
    scenarioHarnessFailedCount: integer("scenario_harness_failed_count")
      .notNull()
      .default(0),
    scenarioErroredCount: integer("scenario_errored_count")
      .notNull()
      .default(0),
    finalErrorJson: jsonb("final_error_json"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_runs_status").on(table.status),
    index("idx_runs_trigger").on(table.trigger),
    index("idx_runs_preset_id").on(table.presetId),
    index("idx_runs_started_at").on(table.startedAt),
    index("idx_runs_suite_fingerprint").on(table.suiteFingerprint),
  ],
);

export const postgresScenarioRuns = pgTable(
  "scenario_runs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => postgresRuns.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    scenarioId: text("scenario_id").notNull(),
    scenarioName: text("scenario_name").notNull(),
    personaId: text("persona_id").notNull(),
    rubricId: text("rubric_id").notNull(),
    userId: text("user_id"),
    tagsJson: jsonb("tags_json"),
    priority: text("priority"),
    expectationsJson: jsonb("expectations_json"),
    scenarioSnapshotJson: jsonb("scenario_snapshot_json"),
    personaSnapshotJson: jsonb("persona_snapshot_json"),
    rubricSnapshotJson: jsonb("rubric_snapshot_json"),
    status: text("status").notNull(),
    passed: boolean("passed"),
    failureKind: text("failure_kind"),
    overallScore: doublePrecision("overall_score"),
    passThreshold: doublePrecision("pass_threshold"),
    judgeProvider: text("judge_provider"),
    judgeModel: text("judge_model"),
    judgeTemperature: doublePrecision("judge_temperature"),
    judgeMaxTokens: integer("judge_max_tokens"),
    overallNotes: text("overall_notes"),
    judgeOutputJson: jsonb("judge_output_json"),
    turnCount: integer("turn_count").notNull().default(0),
    assistantTurnCount: integer("assistant_turn_count").notNull().default(0),
    toolCallCount: integer("tool_call_count").notNull().default(0),
    checkpointCount: integer("checkpoint_count").notNull().default(0),
    errorJson: jsonb("error_json"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_scenario_runs_run_id").on(table.runId),
    index("idx_scenario_runs_scenario_id").on(table.scenarioId),
  ],
);

export const postgresTurns = pgTable(
  "turns",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    scenarioRunId: bigint("scenario_run_id", { mode: "number" })
      .notNull()
      .references(() => postgresScenarioRuns.id, { onDelete: "cascade" }),
    turnIndex: integer("turn_index").notNull(),
    role: text("role").notNull(),
    source: text("source").notNull(),
    content: text("content"),
    generatorModel: text("generator_model"),
    latencyMs: doublePrecision("latency_ms"),
    usageJson: jsonb("usage_json"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("idx_turns_scenario_run").on(table.scenarioRunId, table.turnIndex),
  ],
);

export const postgresTargetEvents = pgTable(
  "target_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    scenarioRunId: bigint("scenario_run_id", { mode: "number" })
      .notNull()
      .references(() => postgresScenarioRuns.id, { onDelete: "cascade" }),
    turnIndex: integer("turn_index").notNull(),
    exchangeIndex: integer("exchange_index").notNull(),
    rawExchangeJson: jsonb("raw_exchange_json"),
    latencyMs: doublePrecision("latency_ms"),
    usageJson: jsonb("usage_json"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("idx_target_events_scenario_run").on(
      table.scenarioRunId,
      table.turnIndex,
      table.exchangeIndex,
    ),
  ],
);

export const postgresToolCalls = pgTable(
  "tool_calls",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    scenarioRunId: bigint("scenario_run_id", { mode: "number" })
      .notNull()
      .references(() => postgresScenarioRuns.id, { onDelete: "cascade" }),
    turnIndex: integer("turn_index").notNull(),
    callOrder: integer("call_order"),
    name: text("name").notNull(),
    argsJson: jsonb("args_json"),
    rawJson: jsonb("raw_json"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("idx_tool_calls_scenario_run").on(
      table.scenarioRunId,
      table.turnIndex,
    ),
  ],
);

export const postgresCheckpoints = pgTable(
  "checkpoints",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    scenarioRunId: bigint("scenario_run_id", { mode: "number" })
      .notNull()
      .references(() => postgresScenarioRuns.id, { onDelete: "cascade" }),
    checkpointIndex: integer("checkpoint_index").notNull(),
    precedingTurnIndex: integer("preceding_turn_index"),
    passed: boolean("passed").notNull(),
    failuresJson: jsonb("failures_json"),
    assertionsJson: jsonb("assertions_json"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("idx_checkpoints_scenario_run").on(
      table.scenarioRunId,
      table.checkpointIndex,
    ),
  ],
);

export const postgresJudgeDimensionScores = pgTable(
  "judge_dimension_scores",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    scenarioRunId: bigint("scenario_run_id", { mode: "number" })
      .notNull()
      .references(() => postgresScenarioRuns.id, { onDelete: "cascade" }),
    dimensionId: text("dimension_id").notNull(),
    dimensionName: text("dimension_name").notNull(),
    weight: doublePrecision("weight").notNull(),
    scaleType: text("scale_type").notNull(),
    scalePoints: doublePrecision("scale_points"),
    rawScore: doublePrecision("raw_score").notNull(),
    normalizedScore: doublePrecision("normalized_score").notNull(),
    reasoning: text("reasoning").notNull(),
    evidenceJson: jsonb("evidence_json"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [index("idx_judge_scores_scenario_run").on(table.scenarioRunId)],
);

export const postgresHumanDimensionScores = pgTable(
  "human_dimension_scores",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    scenarioRunId: bigint("scenario_run_id", { mode: "number" })
      .notNull()
      .references(() => postgresScenarioRuns.id, { onDelete: "cascade" }),
    dimensionId: text("dimension_id").notNull(),
    dimensionName: text("dimension_name").notNull(),
    scaleType: text("scale_type").notNull(),
    scalePoints: doublePrecision("scale_points"),
    rawScore: doublePrecision("raw_score").notNull(),
    normalizedScore: doublePrecision("normalized_score").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("idx_human_dim_scores_scenario_run").on(table.scenarioRunId),
  ],
);

export const postgresPresets = pgTable("presets", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  description: text("description"),
  endpoint: text("endpoint").notNull(),
  personas: text("personas").notNull(),
  rubric: text("rubric").notNull(),
  parallelEnabled: boolean("parallel_enabled").notNull().default(false),
  parallelLimit: integer("parallel_limit"),
  repeat: integer("repeat").notNull().default(1),
  dryRun: boolean("dry_run").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export const postgresPresetScenarios = pgTable(
  "preset_scenarios",
  {
    presetId: text("preset_id")
      .notNull()
      .references(() => postgresPresets.id, { onDelete: "cascade" }),
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

export const postgresAppSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  ciphertext: text("ciphertext").notNull(),
  iv: text("iv").notNull(),
  authTag: text("auth_tag").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const postgresEndpointOverrides = pgTable("endpoint_overrides", {
  endpointPath: text("endpoint_path").primaryKey(),
  overridesJson: jsonb("overrides_json").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const postgresSchema = {
  meta: postgresMeta,
  runs: postgresRuns,
  scenarioRuns: postgresScenarioRuns,
  turns: postgresTurns,
  targetEvents: postgresTargetEvents,
  toolCalls: postgresToolCalls,
  checkpoints: postgresCheckpoints,
  judgeDimensionScores: postgresJudgeDimensionScores,
  humanDimensionScores: postgresHumanDimensionScores,
  presets: postgresPresets,
  presetScenarios: postgresPresetScenarios,
  appSettings: postgresAppSettings,
  endpointOverrides: postgresEndpointOverrides,
};

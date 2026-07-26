import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";

import type {
  AdapterReply,
  CheckpointAssertion,
  CheckpointResult,
  JsonValue,
  Persona,
  Rubric,
  RubricScore,
  RunResult,
  Scenario,
  ScenarioRunResult,
} from "../../shared/types/contracts.ts";
import {
  AgentProbeRuntimeError,
  errorPayload,
} from "../../shared/utils/errors.ts";
import { normalizeDimensionScore } from "../../shared/utils/scoring.ts";
import type { SqlTag } from "./postgres-client.ts";
import type {
  RunRecorderConfigurationOptions,
  RunRecorderStartOptions,
} from "./types.ts";

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

function json(value: unknown): string {
  return JSON.stringify(value === undefined ? null : value);
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

function scenarioStatusForError(error: Error): string {
  return error.name === "AgentProbeRuntimeError" ? "runtime_error" : "error";
}

function normalizedDimensionScore(
  rubric: Rubric,
  dimensionId: string,
  rawScore: number,
): number {
  const dimension = rubric.dimensions.find((item) => item.id === dimensionId);
  return normalizeDimensionScore(dimension, rawScore);
}

async function refreshRunCounts(sql: SqlTag, runId: string): Promise<void> {
  await sql`
    update runs set
      scenario_total = (
        select count(*)::integer from scenario_runs where run_id = ${runId}
      ),
      scenario_passed_count = (
        select count(*)::integer from scenario_runs
        where run_id = ${runId} and passed = true
      ),
      scenario_failed_count = (
        select count(*)::integer from scenario_runs
        where run_id = ${runId} and passed = false
          and status not in ('error', 'runtime_error')
          and coalesce(failure_kind, 'agent') <> 'harness'
      ),
      scenario_harness_failed_count = (
        select count(*)::integer from scenario_runs
        where run_id = ${runId} and passed = false and failure_kind = 'harness'
      ),
      scenario_errored_count = (
        select count(*)::integer from scenario_runs
        where run_id = ${runId} and status in ('error', 'runtime_error')
      ),
      updated_at = now()
    where id = ${runId}
  `;
}

export class PostgresRunRecorder {
  runId?: string;

  constructor(private readonly sql: SqlTag) {}

  private requireRunId(): string {
    if (!this.runId) {
      throw new AgentProbeRuntimeError("Run recorder has not been started.");
    }
    return this.runId;
  }

  async recordRunStarted(options: RunRecorderStartOptions): Promise<string> {
    const runId = randomUUID().replaceAll("-", "");
    this.runId = runId;
    await this.sql`
      insert into runs (
        id, status, passed, exit_code, label, notes, trigger, preset_id,
        preset_snapshot_json, filters_json, selected_scenario_ids_json,
        source_paths_json, scenario_total, scenario_passed_count,
        scenario_failed_count, scenario_harness_failed_count,
        scenario_errored_count, started_at, updated_at
      ) values (
        ${runId}, 'running', null, null, ${options.label ?? null},
        ${options.notes ?? null}, ${options.trigger ?? "cli"},
        ${options.presetId ?? null},
        ${json(redactValue(options.presetSnapshot ?? null))}::jsonb,
        ${json(
          filtersPayload({
            scenarioFilter: options.scenarioFilter,
            tags: options.tags,
          }),
        )}::jsonb,
        ${json([])}::jsonb,
        ${json(
          sourcePathsPayload({
            endpoint: options.endpoint,
            scenarios: options.scenarios,
            personas: options.personas,
            rubric: options.rubric,
          }),
        )}::jsonb,
        0, 0, 0, 0, 0, now(), now()
      )
    `;
    return runId;
  }

  async recordRunConfiguration(
    options: RunRecorderConfigurationOptions,
  ): Promise<void> {
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

    await this.sql`
      update runs set
        transport = ${options.endpointConfig.transport ?? null},
        preset = ${options.endpointConfig.preset ?? null},
        selected_scenario_ids_json = ${json(selectedScenarioIds)}::jsonb,
        suite_fingerprint = ${suiteFingerprint},
        endpoint_config_hash = ${endpointHash},
        scenarios_config_hash = ${scenariosHash},
        personas_config_hash = ${personasHash},
        rubric_config_hash = ${rubricHash},
        endpoint_snapshot_json = ${json(redactedEndpointSnapshot)}::jsonb,
        scenario_total = ${selectedScenarioIds.length},
        updated_at = now()
      where id = ${this.requireRunId()}
    `;
  }

  async recordRunFinished(result: RunResult): Promise<void> {
    const runId = this.requireRunId();
    await refreshRunCounts(this.sql, runId);
    await this.sql`
      update runs set
        status = ${result.cancelled ? "cancelled" : "completed"},
        passed = ${result.cancelled ? false : result.passed},
        exit_code = ${result.exitCode},
        completed_at = now(),
        cancelled_at = ${result.cancelled ? new Date() : null},
        updated_at = now()
      where id = ${runId}
    `;
  }

  async recordRunCancelled(result?: RunResult): Promise<void> {
    const runId = this.requireRunId();
    await refreshRunCounts(this.sql, runId);
    await this.sql`
      update runs set
        status = 'cancelled',
        passed = false,
        exit_code = ${result?.exitCode ?? 130},
        completed_at = now(),
        cancelled_at = now(),
        updated_at = now()
      where id = ${runId}
    `;
  }

  async recordRunError(
    error: Error,
    options: { exitCode: number },
  ): Promise<void> {
    const runId = this.requireRunId();
    await refreshRunCounts(this.sql, runId);
    await this.sql`
      update runs set
        status = ${runStatusForExitCode(options.exitCode)},
        passed = false,
        exit_code = ${options.exitCode},
        final_error_json = ${json(errorPayload(error))}::jsonb,
        completed_at = now(),
        updated_at = now()
      where id = ${runId}
    `;
  }

  async recordScenarioStarted(options: {
    scenario: Scenario;
    persona: Persona;
    rubric: Rubric;
    ordinal?: number;
    userId?: string;
  }): Promise<number> {
    const rows = await this.sql<{ id: number | string | bigint }>`
      insert into scenario_runs (
        run_id, ordinal, scenario_id, scenario_name, persona_id, rubric_id,
        user_id, tags_json, priority, expectations_json, scenario_snapshot_json,
        persona_snapshot_json, rubric_snapshot_json, status, pass_threshold,
        judge_provider, judge_model, judge_temperature, judge_max_tokens,
        turn_count, assistant_turn_count, tool_call_count, checkpoint_count,
        started_at, updated_at
      ) values (
        ${this.requireRunId()}, ${options.ordinal ?? 0},
        ${options.scenario.id}, ${options.scenario.name},
        ${options.persona.id}, ${options.rubric.id}, ${options.userId ?? null},
        ${json(redactValue(options.scenario.tags))}::jsonb,
        ${options.scenario.priority ?? null},
        ${json(redactValue(options.scenario.expectations))}::jsonb,
        ${json(redactValue(options.scenario))}::jsonb,
        ${json(redactValue(options.persona))}::jsonb,
        ${json(redactValue(options.rubric))}::jsonb,
        'running',
        ${options.rubric.passThreshold},
        ${options.rubric.judge?.provider ?? null},
        ${options.rubric.judge?.model ?? null},
        ${options.rubric.judge?.temperature ?? null},
        ${options.rubric.judge?.maxTokens ?? null},
        0, 0, 0, 0, now(), now()
      )
      returning id
    `;
    await refreshRunCounts(this.sql, this.requireRunId());
    return Number(rows[0]?.id);
  }

  async recordTurn(
    scenarioRunId: number,
    options: {
      turnIndex: number;
      turn: { role: string; content?: string | null };
      source: string;
      generatorModel?: string;
    },
  ): Promise<void> {
    await this.sql`
      insert into turns (
        scenario_run_id, turn_index, role, source, content, generator_model, created_at
      ) values (
        ${scenarioRunId}, ${options.turnIndex}, ${options.turn.role},
        ${options.source}, ${options.turn.content ?? null},
        ${options.generatorModel ?? null}, now()
      )
    `;
    await this.sql`
      update scenario_runs set
        turn_count = turn_count + 1,
        assistant_turn_count = assistant_turn_count + ${options.source === "assistant" ? 1 : 0},
        updated_at = now()
      where id = ${scenarioRunId}
    `;
  }

  async recordAssistantReply(
    scenarioRunId: number,
    options: { turnIndex: number; reply: AdapterReply },
  ): Promise<void> {
    await this.sql`
      update turns set
        latency_ms = ${options.reply.latencyMs},
        usage_json = ${json(redactValue(options.reply.usage))}::jsonb
      where scenario_run_id = ${scenarioRunId}
        and turn_index = ${options.turnIndex}
    `;
    const rows = await this.sql<{ next_exchange: number | string }>`
      select coalesce(max(exchange_index), -1) + 1 as next_exchange
      from target_events
      where scenario_run_id = ${scenarioRunId}
        and turn_index = ${options.turnIndex}
    `;
    await this.sql`
      insert into target_events (
        scenario_run_id, turn_index, exchange_index, raw_exchange_json,
        latency_ms, usage_json, created_at
      ) values (
        ${scenarioRunId}, ${options.turnIndex}, ${Number(rows[0]?.next_exchange ?? 0)},
        ${json(redactValue(options.reply.rawExchange))}::jsonb,
        ${options.reply.latencyMs},
        ${json(redactValue(options.reply.usage))}::jsonb,
        now()
      )
    `;

    for (const toolCall of options.reply.toolCalls) {
      await this.sql`
        insert into tool_calls (
          scenario_run_id, turn_index, call_order, name, args_json, raw_json, created_at
        ) values (
          ${scenarioRunId}, ${options.turnIndex}, ${toolCall.order ?? null},
          ${toolCall.name}, ${json(redactValue(toolCall.args))}::jsonb,
          ${json(redactValue(toolCall.raw))}::jsonb, now()
        )
      `;
    }

    await this.sql`
      update scenario_runs set
        tool_call_count = tool_call_count + ${options.reply.toolCalls.length},
        updated_at = now()
      where id = ${scenarioRunId}
    `;
  }

  async recordCheckpoint(
    scenarioRunId: number,
    options: {
      checkpointIndex: number;
      precedingTurnIndex?: number;
      assertions: CheckpointAssertion[];
      result: CheckpointResult;
    },
  ): Promise<void> {
    await this.sql`
      insert into checkpoints (
        scenario_run_id, checkpoint_index, preceding_turn_index, passed,
        failures_json, assertions_json, created_at
      ) values (
        ${scenarioRunId}, ${options.checkpointIndex},
        ${options.precedingTurnIndex ?? null}, ${options.result.passed},
        ${json(redactValue(options.result.failures))}::jsonb,
        ${json(redactValue(options.assertions))}::jsonb, now()
      )
    `;
    await this.sql`
      update scenario_runs set
        checkpoint_count = checkpoint_count + 1,
        updated_at = now()
      where id = ${scenarioRunId}
    `;
  }

  async recordJudgeResult(
    scenarioRunId: number,
    options: {
      rubric: Rubric;
      score: RubricScore;
      overallScore: number;
    },
  ): Promise<void> {
    for (const dimension of options.rubric.dimensions) {
      const dimensionScore = options.score.dimensions[dimension.id];
      if (!dimensionScore) {
        continue;
      }
      await this.sql`
        insert into judge_dimension_scores (
          scenario_run_id, dimension_id, dimension_name, weight, scale_type,
          scale_points, raw_score, normalized_score, reasoning, evidence_json,
          created_at
        ) values (
          ${scenarioRunId}, ${dimension.id}, ${dimension.name},
          ${dimension.weight}, ${dimension.scale.type},
          ${dimension.scale.points ?? null}, ${dimensionScore.score},
          ${normalizedDimensionScore(
            options.rubric,
            dimension.id,
            dimensionScore.score,
          )},
          ${dimensionScore.reasoning},
          ${json(redactValue(dimensionScore.evidence))}::jsonb,
          now()
        )
      `;
    }

    await this.sql`
      update scenario_runs set
        overall_score = ${options.overallScore},
        overall_notes = ${options.score.overallNotes},
        judge_output_json = ${json(
          redactValue({
            dimensions: options.score.dimensions,
            overall_notes: options.score.overallNotes,
            pass: options.score.passed,
            failure_mode_detected: options.score.failureModeDetected ?? null,
          }),
        )}::jsonb,
        updated_at = now()
      where id = ${scenarioRunId}
    `;
  }

  async recordScenarioFinished(
    scenarioRunId: number,
    options: { result: ScenarioRunResult },
  ): Promise<void> {
    await this.sql`
      update scenario_runs set
        status = 'completed',
        passed = ${options.result.passed},
        failure_kind = ${options.result.failureKind ?? null},
        overall_score = ${options.result.overallScore},
        completed_at = now(),
        updated_at = now()
      where id = ${scenarioRunId}
    `;
    await refreshRunCounts(this.sql, this.requireRunId());
  }

  async recordScenarioError(
    scenarioRunId: number,
    error: Error,
  ): Promise<void> {
    await this.sql`
      update scenario_runs set
        status = ${scenarioStatusForError(error)},
        passed = false,
        error_json = ${json(errorPayload(error))}::jsonb,
        completed_at = now(),
        updated_at = now()
      where id = ${scenarioRunId}
    `;
    await refreshRunCounts(this.sql, this.requireRunId());
  }
}

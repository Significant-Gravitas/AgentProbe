import { randomBytes, randomUUID } from "node:crypto";

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
import { logWarn } from "../../shared/utils/logging.ts";
import { createPostgresClient, type SqlTag } from "./postgres-client.ts";
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
import type {
  RunRecorder,
  RunRecorderConfigurationOptions,
  RunRecorderStartOptions,
} from "./types.ts";

/**
 * One queued write against Postgres. Each op is a self-contained async closure
 * so the flush loop only needs a FIFO drain — ordering between ops is
 * preserved.
 */
type Op = (tx: SqlTag) => Promise<void>;

const MAX_FLUSH_ATTEMPTS = 3;

/**
 * 52-bit client-assigned scenario_run_id: 24-bit random high (stable per
 * recorder instance) + 28-bit monotonic counter. Fits `number` safe-integer
 * (2^53 − 1) and gives a per-recorder collision probability of ~1/16M against
 * any other concurrent recorder, sufficient for evaluation workloads.
 */
function makeScenarioIdAllocator(): () => number {
  const highBits = randomBytes(3).readUIntBE(0, 3); // 0..2^24 - 1
  let counter = 0;
  return () => {
    counter += 1;
    if (counter >= 1 << 28) {
      throw new AgentProbeRuntimeError(
        "Postgres recorder exhausted the per-run scenario ID counter (2^28).",
      );
    }
    return highBits * (1 << 28) + counter;
  };
}

/**
 * Async-buffered Postgres recorder. Implements the synchronous `RunRecorder`
 * contract by queueing each write as an async closure and draining the queue
 * through a single in-flight `Bun.SQL` transaction at a time. Callers must
 * `await recorder.drain()` after `runSuite` returns so that flush failures are
 * surfaced on the run path instead of being swallowed.
 */
export class PostgresRunRecorder implements RunRecorder {
  readonly dbUrl: string;
  runId?: string;

  private readonly sql: SqlTag;
  private readonly queue: Op[] = [];
  private readonly allocateScenarioId: () => number;
  private readonly exchangeCounters = new Map<string, number>();

  private flushPromise: Promise<void> | null = null;
  private lastFlushError: Error | null = null;
  private closed = false;

  constructor(dbUrl: string) {
    this.dbUrl = dbUrl;
    this.sql = createPostgresClient(dbUrl);
    this.allocateScenarioId = makeScenarioIdAllocator();
  }

  // ---------- public lifecycle helpers ----------

  /**
   * Wait for all queued writes to land. Called by the CLI/server after
   * `runSuite` returns so flush errors can fail the run. Throws the last
   * flush error if any remain unresolved.
   */
  async drain(): Promise<void> {
    while (this.queue.length > 0 || this.flushPromise) {
      if (!this.flushPromise) {
        this.scheduleFlush();
      }
      if (this.flushPromise) {
        try {
          await this.flushPromise;
        } catch {
          // flush already records lastFlushError; fall through to re-check.
        }
      }
    }
    if (this.lastFlushError) {
      const error = this.lastFlushError;
      this.lastFlushError = null;
      throw new AgentProbeRuntimeError(
        `Postgres recorder failed to flush buffered events: ${error.message}`,
      );
    }
  }

  /** Close the underlying connection. Safe to call multiple times. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.sql.end?.();
    } catch {
      // best-effort close
    }
  }

  // ---------- RunRecorder interface ----------

  recordRunStarted(options: RunRecorderStartOptions): string {
    const runId = randomUUID().replaceAll("-", "");
    this.runId = runId;
    const now = utcNow();
    const presetSnapshot = redactValue(options.presetSnapshot ?? null);
    const filters = filtersPayload({
      scenarioFilter: options.scenarioFilter,
      tags: options.tags,
    });
    const sourcePaths = sourcePathsPayload({
      endpoint: options.endpoint,
      scenarios: options.scenarios,
      personas: options.personas,
      rubric: options.rubric,
    });
    const label = options.label ?? null;
    const trigger = options.trigger ?? "cli";
    const presetId = options.presetId ?? null;
    this.enqueue(async (tx) => {
      await tx`
        insert into runs (
          id, status, passed, exit_code, label, trigger, preset_id,
          preset_snapshot_json, filters_json, selected_scenario_ids_json,
          source_paths_json, scenario_total, scenario_passed_count,
          scenario_failed_count, scenario_errored_count, started_at, updated_at
        ) values (
          ${runId}, 'running', null, null, ${label}, ${trigger}, ${presetId},
          ${jsonbOrNull(presetSnapshot)}, ${jsonbOrNull(filters)}, ${jsonbOrNull([])},
          ${jsonbOrNull(sourcePaths)}, 0, 0, 0, 0, ${now}, ${now}
        )
      `;
    });
    return runId;
  }

  recordRunConfiguration(options: RunRecorderConfigurationOptions): void {
    const runId = this.requireRunId();
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
    const transport = options.endpointConfig.transport ?? null;
    const preset = options.endpointConfig.preset ?? null;
    const totalSelected = selectedScenarioIds.length;
    this.enqueue(async (tx) => {
      await tx`
        update runs set
          transport = ${transport},
          preset = ${preset},
          selected_scenario_ids_json = ${jsonbOrNull(selectedScenarioIds)},
          suite_fingerprint = ${suiteFingerprint},
          endpoint_config_hash = ${endpointHash},
          scenarios_config_hash = ${scenariosHash},
          personas_config_hash = ${personasHash},
          rubric_config_hash = ${rubricHash},
          endpoint_snapshot_json = ${jsonbOrNull(redactedEndpointSnapshot)},
          scenario_total = ${totalSelected},
          updated_at = ${utcNow()}
        where id = ${runId}
      `;
    });
  }

  recordRunFinished(result: RunResult): void {
    const runId = this.requireRunId();
    const cancelled = Boolean(result.cancelled);
    const status = cancelled ? "cancelled" : "completed";
    const passed = cancelled ? false : Boolean(result.passed);
    const cancelledAt = cancelled ? utcNow() : null;
    const exitCode = result.exitCode;
    this.queueRefreshCounts();
    this.enqueue(async (tx) => {
      await tx`
        update runs set
          status = ${status},
          passed = ${passed},
          exit_code = ${exitCode},
          completed_at = ${utcNow()},
          cancelled_at = ${cancelledAt},
          updated_at = ${utcNow()}
        where id = ${runId}
      `;
    });
  }

  recordRunCancelled(result?: RunResult): void {
    const runId = this.requireRunId();
    const exitCode = result?.exitCode ?? 130;
    this.queueRefreshCounts();
    this.enqueue(async (tx) => {
      const now = utcNow();
      await tx`
        update runs set
          status = 'cancelled',
          passed = false,
          exit_code = ${exitCode},
          completed_at = coalesce(completed_at, ${now}),
          cancelled_at = coalesce(cancelled_at, ${now}),
          updated_at = ${now}
        where id = ${runId}
      `;
    });
  }

  recordRunError(error: Error, options: { exitCode: number }): void {
    const runId = this.requireRunId();
    const status = runStatusForExitCode(options.exitCode);
    const errorJson = errorPayload(error);
    const exitCode = options.exitCode;
    this.queueRefreshCounts();
    this.enqueue(async (tx) => {
      await tx`
        update runs set
          status = ${status},
          passed = false,
          exit_code = ${exitCode},
          final_error_json = ${jsonbOrNull(errorJson)},
          completed_at = ${utcNow()},
          updated_at = ${utcNow()}
        where id = ${runId}
      `;
    });
  }

  recordScenarioStarted(options: {
    scenario: Scenario;
    persona: Persona;
    rubric: Rubric;
    ordinal?: number;
    userId?: string;
  }): number {
    const runId = this.requireRunId();
    const scenarioRunId = this.allocateScenarioId();
    const now = utcNow();
    const ordinal = options.ordinal ?? 0;
    const scenario = options.scenario;
    const persona = options.persona;
    const rubric = options.rubric;
    const userId = options.userId ?? null;
    const tagsJson = redactValue(scenario.tags);
    const priority = scenario.priority ?? null;
    const expectationsJson = redactValue(scenario.expectations);
    const scenarioSnapshot = redactValue(scenario);
    const personaSnapshot = redactValue(persona);
    const rubricSnapshot = redactValue(rubric);
    const judgeProvider = rubric.judge?.provider ?? null;
    const judgeModel = rubric.judge?.model ?? null;
    const judgeTemperature = rubric.judge?.temperature ?? null;
    const judgeMaxTokens = rubric.judge?.maxTokens ?? null;
    const passThreshold = rubric.passThreshold;
    this.enqueue(async (tx) => {
      await tx`
        insert into scenario_runs (
          id, run_id, ordinal, scenario_id, scenario_name, persona_id, rubric_id,
          user_id, tags_json, priority, expectations_json, scenario_snapshot_json,
          persona_snapshot_json, rubric_snapshot_json, status, pass_threshold,
          judge_provider, judge_model, judge_temperature, judge_max_tokens,
          turn_count, assistant_turn_count, tool_call_count, checkpoint_count,
          started_at, updated_at
        ) values (
          ${scenarioRunId}, ${runId}, ${ordinal}, ${scenario.id}, ${scenario.name},
          ${persona.id}, ${rubric.id}, ${userId}, ${jsonbOrNull(tagsJson)},
          ${priority}, ${jsonbOrNull(expectationsJson)},
          ${jsonbOrNull(scenarioSnapshot)}, ${jsonbOrNull(personaSnapshot)},
          ${jsonbOrNull(rubricSnapshot)}, 'running', ${passThreshold},
          ${judgeProvider}, ${judgeModel}, ${judgeTemperature}, ${judgeMaxTokens},
          0, 0, 0, 0, ${now}, ${now}
        )
      `;
    });
    this.queueRefreshCounts();
    return scenarioRunId;
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
    const role = options.turn.role;
    const source = options.source;
    const content = options.turn.content ?? null;
    const generatorModel = options.generatorModel ?? null;
    const turnIndex = options.turnIndex;
    const isAssistant = source === "assistant" ? 1 : 0;
    this.enqueue(async (tx) => {
      const now = utcNow();
      await tx`
        insert into turns (
          scenario_run_id, turn_index, role, source, content, generator_model, created_at
        ) values (
          ${scenarioRunId}, ${turnIndex}, ${role}, ${source}, ${content},
          ${generatorModel}, ${now}
        )
      `;
      await tx`
        update scenario_runs set
          turn_count = turn_count + 1,
          assistant_turn_count = assistant_turn_count + ${isAssistant},
          updated_at = ${now}
        where id = ${scenarioRunId}
      `;
    });
  }

  recordAssistantReply(
    scenarioRunId: number,
    options: { turnIndex: number; reply: AdapterReply },
  ): void {
    const turnIndex = options.turnIndex;
    const reply = options.reply;
    const latency = reply.latencyMs;
    const usageRedacted = redactValue(reply.usage);
    const rawExchangeRedacted = redactValue(reply.rawExchange);
    const toolCalls = reply.toolCalls.map((call) => ({
      order: call.order ?? null,
      name: call.name,
      argsJson: redactValue(call.args),
      rawJson: redactValue(call.raw),
    }));
    const exchangeIndex = this.nextExchangeIndex(scenarioRunId, turnIndex);
    this.enqueue(async (tx) => {
      const now = utcNow();
      await tx`
        update turns set
          latency_ms = ${latency},
          usage_json = ${jsonbOrNull(usageRedacted)}
        where scenario_run_id = ${scenarioRunId} and turn_index = ${turnIndex}
      `;
      await tx`
        insert into target_events (
          scenario_run_id, turn_index, exchange_index, raw_exchange_json,
          latency_ms, usage_json, created_at
        ) values (
          ${scenarioRunId}, ${turnIndex}, ${exchangeIndex},
          ${jsonbOrNull(rawExchangeRedacted)}, ${latency},
          ${jsonbOrNull(usageRedacted)}, ${now}
        )
      `;
      for (const call of toolCalls) {
        await tx`
          insert into tool_calls (
            scenario_run_id, turn_index, call_order, name, args_json, raw_json, created_at
          ) values (
            ${scenarioRunId}, ${turnIndex}, ${call.order}, ${call.name},
            ${jsonbOrNull(call.argsJson)}, ${jsonbOrNull(call.rawJson)}, ${now}
          )
        `;
      }
      if (toolCalls.length > 0) {
        await tx`
          update scenario_runs set
            tool_call_count = tool_call_count + ${toolCalls.length},
            updated_at = ${now}
          where id = ${scenarioRunId}
        `;
      }
    });
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
    const checkpointIndex = options.checkpointIndex;
    const precedingTurnIndex = options.precedingTurnIndex ?? null;
    const passed = Boolean(options.result.passed);
    const failuresJson = redactValue(options.result.failures);
    const assertionsJson = redactValue(options.assertions);
    this.enqueue(async (tx) => {
      const now = utcNow();
      await tx`
        insert into checkpoints (
          scenario_run_id, checkpoint_index, preceding_turn_index, passed,
          failures_json, assertions_json, created_at
        ) values (
          ${scenarioRunId}, ${checkpointIndex}, ${precedingTurnIndex}, ${passed},
          ${jsonbOrNull(failuresJson)}, ${jsonbOrNull(assertionsJson)}, ${now}
        )
      `;
      await tx`
        update scenario_runs set
          checkpoint_count = checkpoint_count + 1,
          updated_at = ${now}
        where id = ${scenarioRunId}
      `;
    });
  }

  recordJudgeResult(
    scenarioRunId: number,
    options: {
      rubric: Rubric;
      score: RubricScore;
      overallScore: number;
    },
  ): void {
    const rubric = options.rubric;
    const score = options.score;
    const rows = rubric.dimensions.flatMap((dimension) => {
      const dimensionScore = score.dimensions[dimension.id];
      if (!dimensionScore) return [];
      return [
        {
          dimensionId: dimension.id,
          dimensionName: dimension.name,
          weight: dimension.weight,
          scaleType: dimension.scale.type,
          scalePoints: dimension.scale.points ?? null,
          rawScore: dimensionScore.score,
          normalizedScore: normalizedDimensionScore(
            rubric,
            dimension.id,
            dimensionScore.score,
          ),
          reasoning: dimensionScore.reasoning,
          evidenceJson: redactValue(dimensionScore.evidence),
        },
      ];
    });
    const overallScore = options.overallScore;
    const overallNotes = score.overallNotes;
    const judgeOutput = redactValue({
      dimensions: score.dimensions,
      overall_notes: score.overallNotes,
      pass: score.passed,
      failure_mode_detected: score.failureModeDetected ?? null,
    });
    this.enqueue(async (tx) => {
      const now = utcNow();
      for (const row of rows) {
        await tx`
          insert into judge_dimension_scores (
            scenario_run_id, dimension_id, dimension_name, weight, scale_type,
            scale_points, raw_score, normalized_score, reasoning, evidence_json, created_at
          ) values (
            ${scenarioRunId}, ${row.dimensionId}, ${row.dimensionName},
            ${row.weight}, ${row.scaleType}, ${row.scalePoints}, ${row.rawScore},
            ${row.normalizedScore}, ${row.reasoning},
            ${jsonbOrNull(row.evidenceJson)}, ${now}
          )
        `;
      }
      await tx`
        update scenario_runs set
          overall_score = ${overallScore},
          overall_notes = ${overallNotes},
          judge_output_json = ${jsonbOrNull(judgeOutput)},
          updated_at = ${now}
        where id = ${scenarioRunId}
      `;
    });
  }

  recordScenarioFinished(
    scenarioRunId: number,
    options: { result: ScenarioRunResult },
  ): void {
    const result = options.result;
    const passed = Boolean(result.passed);
    const failureKind = result.failureKind ?? null;
    const overallScore = result.overallScore;
    this.enqueue(async (tx) => {
      const now = utcNow();
      await tx`
        update scenario_runs set
          status = 'completed',
          passed = ${passed},
          failure_kind = ${failureKind},
          overall_score = ${overallScore},
          completed_at = ${now},
          updated_at = ${now}
        where id = ${scenarioRunId}
      `;
    });
    this.queueRefreshCounts();
  }

  recordScenarioError(scenarioRunId: number, error: Error): void {
    const status = scenarioStatusForError(error);
    const errorJson = errorPayload(error);
    this.enqueue(async (tx) => {
      const now = utcNow();
      await tx`
        update scenario_runs set
          status = ${status},
          passed = false,
          error_json = ${jsonbOrNull(errorJson)},
          completed_at = ${now},
          updated_at = ${now}
        where id = ${scenarioRunId}
      `;
    });
    this.queueRefreshCounts();
  }

  // ---------- internals ----------

  private requireRunId(): string {
    if (!this.runId) {
      throw new AgentProbeRuntimeError("Run recorder has not been started.");
    }
    return this.runId;
  }

  private nextExchangeIndex(scenarioRunId: number, turnIndex: number): number {
    const key = `${scenarioRunId}:${turnIndex}`;
    const current = this.exchangeCounters.get(key) ?? -1;
    const next = current + 1;
    this.exchangeCounters.set(key, next);
    return next;
  }

  /**
   * Refresh the aggregate counters on `runs`. Computed server-side from
   * `scenario_runs` so the totals stay consistent even if the recorder's
   * in-memory counts drift (e.g. a cancelled flush).
   */
  private queueRefreshCounts(): void {
    const runId = this.runId;
    if (!runId) return;
    this.enqueue(async (tx) => {
      await tx`
        update runs set
          scenario_total = (
            select count(*) from scenario_runs where run_id = ${runId}
          ),
          scenario_passed_count = (
            select count(*) from scenario_runs
            where run_id = ${runId} and status = 'completed' and passed = true
          ),
          scenario_failed_count = (
            select count(*) from scenario_runs
            where run_id = ${runId} and status = 'completed' and passed = false
          ),
          scenario_harness_failed_count = (
            select count(*) from scenario_runs
            where run_id = ${runId} and status = 'completed'
              and passed = false and failure_kind = 'harness'
          ),
          scenario_errored_count = (
            select count(*) from scenario_runs
            where run_id = ${runId} and status in ('runtime_error', 'error')
          ),
          updated_at = ${utcNow()}
        where id = ${runId}
      `;
    });
  }

  private enqueue(op: Op): void {
    this.queue.push(op);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushPromise || this.closed) return;
    if (this.queue.length === 0) return;
    this.flushPromise = this.flushOnce()
      .catch((error) => {
        this.lastFlushError =
          error instanceof Error ? error : new Error(String(error));
        logWarn("postgres recorder flush failed", {
          dbUrl: this.dbUrl,
          runId: this.runId,
          error: this.lastFlushError.message,
        });
      })
      .finally(() => {
        this.flushPromise = null;
        if (this.queue.length > 0 && !this.closed) {
          this.scheduleFlush();
        }
      });
  }

  private async flushOnce(): Promise<void> {
    const batch = this.queue.splice(0, this.queue.length);
    if (batch.length === 0) return;
    let attempt = 0;
    let lastError: unknown;
    while (attempt < MAX_FLUSH_ATTEMPTS) {
      attempt += 1;
      try {
        await this.sql.begin(async (tx) => {
          for (const op of batch) {
            await op(tx);
          }
        });
        return;
      } catch (error) {
        lastError = error;
        if (attempt >= MAX_FLUSH_ATTEMPTS) break;
        await new Promise((r) => setTimeout(r, 50 * attempt));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}

/**
 * Normalize a JSON-serializable value for a `jsonb` column. Bun's SQL driver
 * accepts plain objects/arrays; `undefined` becomes `null` so the column is
 * explicitly nulled instead of omitted.
 */
function jsonbOrNull(value: JsonValue | unknown): JsonValue | null {
  if (value === undefined) return null;
  return value as JsonValue;
}

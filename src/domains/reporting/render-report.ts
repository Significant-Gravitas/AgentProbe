import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import nunjucks from "nunjucks";

import type { JsonValue, RunRecord, ScenarioRecord } from "../../shared/types/contracts.ts";
import { AgentProbeRuntimeError } from "../../shared/utils/errors.ts";
import {
  DEFAULT_DB_DIRNAME,
  DEFAULT_DB_FILENAME,
  getRun,
  listRuns,
} from "../../providers/persistence/sqlite-run-history.ts";

type TemplateObject = Record<string, unknown>;

const reportEnvironment = new nunjucks.Environment(undefined, {
  autoescape: true,
  trimBlocks: true,
  lstripBlocks: true,
});

function invocationCwd(): string {
  return resolve(process.env.INIT_CWD ?? process.env.PWD ?? process.cwd());
}

function asRecord(value: unknown): TemplateObject | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as TemplateObject;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) =>
    typeof item === "string" && item.trim() ? [item] : [],
  );
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortJson(item));
  }

  const raw = asRecord(value);
  if (!raw) {
    return value;
  }

  return Object.fromEntries(
    Object.keys(raw)
      .sort()
      .map((key) => [key, sortJson(raw[key])]),
  );
}

function prettyJson(value: unknown): string {
  if (
    value === null ||
    value === undefined ||
    value === "" ||
    (Array.isArray(value) && value.length === 0) ||
    (typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      Object.keys(value).length === 0)
  ) {
    return "";
  }

  return JSON.stringify(sortJson(value), null, 2);
}

function formatTimestamp(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    return "n/a";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toISOString().replace("T", " ").replace(".000Z", " UTC");
}

function timestampSortKey(value: unknown): number {
  if (typeof value !== "string" || !value.trim()) {
    return Number.NEGATIVE_INFINITY;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

function formatNumber(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (Number.isInteger(value)) {
      return String(value);
    }
    return value.toFixed(2).replace(/\.?0+$/, "");
  }
  return "n/a";
}

function formatScore(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value.toFixed(2);
  }
  return "n/a";
}

function scorePercent(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(value * 100)));
}

const CREDENTIAL_ERROR_PATTERNS = [
  "401",
  "403",
  "unauthorized",
  "authentication",
  "credential",
  "api key",
  "api_key",
  "apikey",
  "invalid key",
  "invalid token",
  "access denied",
  "permission denied",
  "token expired",
  "auth failed",
];

function isCredentialError(error: unknown): boolean {
  const raw = asRecord(error);
  if (!raw) {
    return false;
  }

  const message = String(raw.message ?? "").toLowerCase();
  const errorType = String(raw.type ?? "").toLowerCase();
  const combined = `${errorType} ${message}`;
  return CREDENTIAL_ERROR_PATTERNS.some((pattern) => combined.includes(pattern));
}

function statusTone(passed: unknown): "success" | "danger" | "neutral" {
  if (passed === true) {
    return "success";
  }
  if (passed === false) {
    return "danger";
  }
  return "neutral";
}

function statusLabel(passed: unknown): "PASS" | "FAIL" | "PENDING" {
  if (passed === true) {
    return "PASS";
  }
  if (passed === false) {
    return "FAIL";
  }
  return "PENDING";
}

function roleTone(role: unknown): "assistant" | "user" | "system" {
  const normalized = String(role ?? "").trim().toLowerCase();
  if (normalized === "assistant") {
    return "assistant";
  }
  if (normalized === "user") {
    return "user";
  }
  return "system";
}

function roleLabel(role: unknown): string {
  const normalized = String(role ?? "").trim().toLowerCase();
  if (normalized === "assistant") {
    return "Assistant";
  }
  if (normalized === "user") {
    return "User";
  }
  if (normalized === "inject") {
    return "Inject";
  }
  if (normalized === "checkpoint") {
    return "Checkpoint";
  }
  if (normalized === "system") {
    return "System";
  }
  return normalized ? normalized[0]!.toUpperCase() + normalized.slice(1) : "Unknown";
}

function buildTurnRows(scenario: ScenarioRecord): TemplateObject[] {
  const toolCallsByTurn = new Map<number, TemplateObject[]>();
  for (const toolCall of scenario.toolCalls) {
    const turnIndex = numberValue(toolCall.turn_index) ?? -1;
    const rows = toolCallsByTurn.get(turnIndex) ?? [];
    rows.push({
      ...toolCall,
      args_pretty: prettyJson(toolCall.args),
      raw_pretty: prettyJson(toolCall.raw),
      call_order_label: formatNumber(toolCall.call_order),
    });
    toolCallsByTurn.set(turnIndex, rows);
  }

  const targetEventsByTurn = new Map<number, TemplateObject[]>();
  for (const event of scenario.targetEvents) {
    const turnIndex = numberValue(event.turn_index) ?? -1;
    const rows = targetEventsByTurn.get(turnIndex) ?? [];
    rows.push({
      ...event,
      raw_exchange_pretty: prettyJson(event.raw_exchange),
      usage_pretty: prettyJson(event.usage),
      latency_label: formatNumber(event.latency_ms),
    });
    targetEventsByTurn.set(turnIndex, rows);
  }

  const checkpointsByTurn = new Map<number | null, TemplateObject[]>();
  for (const checkpoint of scenario.checkpoints) {
    const precedingTurnIndex = numberValue(checkpoint.preceding_turn_index);
    const key = precedingTurnIndex ?? null;
    const rows = checkpointsByTurn.get(key) ?? [];
    rows.push({
      ...checkpoint,
      tone: statusTone(checkpoint.passed),
      status_label: checkpoint.passed === true ? "PASS" : "FAIL",
      assertions_pretty: prettyJson(checkpoint.assertions),
      failures: stringArray(checkpoint.failures),
    });
    checkpointsByTurn.set(key, rows);
  }

  const rows: TemplateObject[] = scenario.turns.map((turn) => {
    const turnIndex = numberValue(turn.turn_index) ?? -1;
    return {
      ...turn,
      created_at_label: formatTimestamp(turn.created_at),
      role_label: roleLabel(turn.role),
      tone: roleTone(turn.role),
      turn_index_label: turnIndex >= 0 ? String(turnIndex) : "–",
      tool_calls: toolCallsByTurn.get(turnIndex) ?? [],
      target_events: targetEventsByTurn.get(turnIndex) ?? [],
      checkpoints: checkpointsByTurn.get(turnIndex) ?? [],
      usage_pretty: prettyJson(turn.usage),
    };
  });

  const leading = checkpointsByTurn.get(null) ?? [];
  if (leading.length > 0) {
    rows.unshift({
      turn_index: -1,
      turn_index_label: "–",
      role_label: "Checkpoint",
      tone: "system",
      content: null,
      created_at_label: "n/a",
      tool_calls: [],
      target_events: [],
      checkpoints: leading,
      usage_pretty: "",
      source: null,
    });
  }

  return rows;
}

function buildDimensionRows(scenario: ScenarioRecord): TemplateObject[] {
  return scenario.judgeDimensionScores.map((dimension) => {
    const scalePoints = numberValue(dimension.scale_points);
    return {
      ...dimension,
      evidence: stringArray(dimension.evidence),
      percent: scorePercent(dimension.normalized_score),
      raw_score_label: formatNumber(dimension.raw_score),
      scale_points_label: formatNumber(dimension.scale_points),
      weight_label: formatNumber(dimension.weight),
      has_scale_points: scalePoints !== undefined,
    };
  });
}

function prepareScenarioView(scenario: ScenarioRecord, index: number): TemplateObject {
  const tags = stringArray(scenario.tags);

  return {
    ...scenario,
    index,
    dom_id: `scenario-${index}`,
    nav_label: `${index + 1}. ${scenario.scenarioName || scenario.scenarioId}`,
    status_label: statusLabel(scenario.passed),
    status_tone: statusTone(scenario.passed),
    is_credential_error: isCredentialError(scenario.error),
    tags,
    tags_csv: tags.join(","),
    score_label: formatScore(scenario.overallScore),
    score_percent: scorePercent(scenario.overallScore),
    threshold_label: formatScore(scenario.passThreshold),
    threshold_percent: scorePercent(scenario.passThreshold),
    turn_rows: buildTurnRows(scenario),
    dimension_rows: buildDimensionRows(scenario),
    overall_notes: scenario.judge.overallNotes ?? "",
    judge_output_pretty: prettyJson(scenario.judge.output),
    error_pretty: prettyJson(scenario.error),
    expectations_pretty: prettyJson(scenario.expectations),
    scenario_snapshot_pretty: prettyJson(scenario.scenarioSnapshot),
    started_at_label: formatTimestamp(scenario.startedAt),
    completed_at_label: formatTimestamp(scenario.completedAt),
    scenario_id: scenario.scenarioId,
    scenario_name: scenario.scenarioName,
    persona_id: scenario.personaId,
    rubric_id: scenario.rubricId,
    pass_threshold: scenario.passThreshold,
    counts: {
      turn_count: scenario.counts.turnCount,
      assistant_turn_count: scenario.counts.assistantTurnCount,
      tool_call_count: scenario.counts.toolCallCount,
      checkpoint_count: scenario.counts.checkpointCount,
    },
    judge: {
      provider: scenario.judge.provider,
      model: scenario.judge.model,
      temperature: scenario.judge.temperature,
      max_tokens: scenario.judge.maxTokens,
      overall_notes: scenario.judge.overallNotes,
      output: scenario.judge.output,
      temperature_label: formatNumber(scenario.judge.temperature),
      max_tokens_label: formatNumber(scenario.judge.maxTokens),
    },
  };
}

function prepareRunView(run: RunRecord): TemplateObject {
  const scenarios = run.scenarios.map((scenario, index) =>
    prepareScenarioView(scenario, index),
  );

  const credentialErrorCount = scenarios.filter((scenario) =>
    scenario.is_credential_error === true,
  ).length;

  const allTags: string[] = [];
  const seenTags = new Set<string>();
  for (const scenario of scenarios) {
    for (const tag of stringArray(scenario.tags)) {
      if (!seenTags.has(tag)) {
        seenTags.add(tag);
        allTags.push(tag);
      }
    }
  }

  return {
    ...run,
    run_id: run.runId,
    run_id_short: run.runId.slice(0, 8),
    started_at_label: formatTimestamp(run.startedAt),
    completed_at_label: formatTimestamp(run.completedAt),
    source_paths_pretty: prettyJson(run.sourcePaths),
    endpoint_snapshot_pretty: prettyJson(run.endpointSnapshot),
    scenario_total: run.aggregateCounts.scenarioTotal,
    scenario_passed_count: run.aggregateCounts.scenarioPassedCount,
    scenario_failed_count: run.aggregateCounts.scenarioFailedCount,
    scenario_errored_count: run.aggregateCounts.scenarioErroredCount,
    credential_error_count: credentialErrorCount,
    all_tags: [...allTags].sort(),
    scenarios,
  };
}

const REPORT_TEMPLATE = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>AgentProbe Report {{ run.run_id }}</title>
    <script src="https://cdn.tailwindcss.com?plugins=typography"></script>
    <script>
      tailwind.config = {
        theme: {
          extend: {
            fontFamily: {
              display: ["Space Grotesk", "ui-sans-serif", "system-ui"],
              body: ["IBM Plex Sans", "ui-sans-serif", "system-ui"]
            },
            colors: {
              report: {
                sand: "#f5f0e8",
                ink: "#111827",
                moss: "#2f6a4f",
                ember: "#b74d2c",
                gold: "#d4a84f",
                slate: "#30475e"
              }
            },
            boxShadow: {
              panel: "0 24px 60px rgba(17, 24, 39, 0.12)"
            }
          }
        }
      };
    </script>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=Space+Grotesk:wght@500;700&display=swap"
      rel="stylesheet"
    />
    <style>
      body {
        background:
          radial-gradient(circle at top left, rgba(212, 168, 79, 0.18), transparent 28rem),
          radial-gradient(circle at top right, rgba(47, 106, 79, 0.16), transparent 26rem),
          linear-gradient(180deg, #fcfbf7 0%, #f4efe6 100%);
      }
      .report-grid {
        background-image:
          linear-gradient(rgba(17, 24, 39, 0.04) 1px, transparent 1px),
          linear-gradient(90deg, rgba(17, 24, 39, 0.04) 1px, transparent 1px);
        background-size: 28px 28px;
      }
    </style>
  </head>
  <body class="report-grid min-h-screen font-body text-report-ink">
    <div class="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <header class="overflow-hidden rounded-[2rem] border border-black/10 bg-white/80 shadow-panel backdrop-blur">
        <div class="grid gap-8 px-6 py-8 lg:grid-cols-[1.5fr,1fr] lg:px-8">
          <div class="space-y-4">
            <div class="inline-flex items-center gap-2 rounded-full border border-black/10 bg-report-sand/80 px-3 py-1 text-xs font-semibold uppercase tracking-[0.24em] text-report-slate">
              AgentProbe Run Report
            </div>
            <div>
              <h1 class="font-display text-4xl font-bold tracking-tight text-report-ink">
                Run {{ run.run_id_short }}
              </h1>
              <p class="mt-2 max-w-2xl text-sm leading-6 text-black/65">
                Inspect the recorded conversation, tool activity, and rubric breakdown for every scenario in this run.
              </p>
            </div>
            <dl class="grid gap-3 text-sm sm:grid-cols-2 xl:grid-cols-4">
              <div class="rounded-2xl border border-black/10 bg-black/[0.03] p-4">
                <dt class="text-black/55">Status</dt>
                <dd class="mt-1 font-semibold">{{ run.status }}</dd>
              </div>
              <div class="rounded-2xl border border-black/10 bg-black/[0.03] p-4">
                <dt class="text-black/55">Started</dt>
                <dd class="mt-1 font-semibold">{{ run.started_at_label }}</dd>
              </div>
              <div class="rounded-2xl border border-black/10 bg-black/[0.03] p-4">
                <dt class="text-black/55">Completed</dt>
                <dd class="mt-1 font-semibold">{{ run.completed_at_label }}</dd>
              </div>
              <div class="rounded-2xl border border-black/10 bg-black/[0.03] p-4">
                <dt class="text-black/55">Preset</dt>
                <dd class="mt-1 font-semibold">{{ run.preset or "custom" }}</dd>
              </div>
            </dl>
          </div>
          <div class="grid gap-3 sm:grid-cols-3 lg:grid-cols-1">
            <div class="rounded-[1.5rem] border border-emerald-950/10 bg-report-moss px-5 py-5 text-white">
              <div class="text-xs uppercase tracking-[0.24em] text-white/70">Passed</div>
              <div class="mt-3 font-display text-4xl font-bold">{{ run.scenario_passed_count }}</div>
            </div>
            <div class="rounded-[1.5rem] border border-amber-950/10 bg-report-gold px-5 py-5 text-report-ink">
              <div class="text-xs uppercase tracking-[0.24em] text-black/55">Failed</div>
              <div class="mt-3 font-display text-4xl font-bold">{{ run.scenario_failed_count }}</div>
              {% if run.credential_error_count > 0 %}
              <div class="mt-2 inline-flex items-center gap-1.5 rounded-full bg-black/10 px-2.5 py-1 text-xs font-semibold text-report-ember">
                <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z"/></svg>
                {{ run.credential_error_count }} credential
              </div>
              {% endif %}
            </div>
            <div class="rounded-[1.5rem] border border-rose-950/10 bg-report-ember px-5 py-5 text-white">
              <div class="text-xs uppercase tracking-[0.24em] text-white/70">Errored</div>
              <div class="mt-3 font-display text-4xl font-bold">{{ run.scenario_errored_count }}</div>
              {% if run.credential_error_count > 0 %}
              <div class="mt-2 inline-flex items-center gap-1.5 rounded-full bg-white/20 px-2.5 py-1 text-xs font-semibold">
                <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z"/></svg>
                {{ run.credential_error_count }} credential
              </div>
              {% endif %}
            </div>
          </div>
        </div>
      </header>

      <div class="mt-8 grid gap-8 xl:grid-cols-[18rem,minmax(0,1fr)]">
        <aside class="space-y-5">
          <section class="rounded-[1.75rem] border border-black/10 bg-white/80 p-5 shadow-panel backdrop-blur">
            <h2 class="font-display text-lg font-bold">Scenarios</h2>
            <div class="mt-4 space-y-3">
              <input
                id="scenario-search"
                type="text"
                placeholder="Search scenarios..."
                class="w-full rounded-xl border border-black/10 bg-black/[0.03] px-3 py-2 text-sm outline-none transition placeholder:text-black/40 focus:border-black/25 focus:bg-white"
              />
              {% if run.all_tags.length > 0 %}
              <select
                id="scenario-tag-filter"
                class="w-full rounded-xl border border-black/10 bg-black/[0.03] px-3 py-2 text-sm outline-none transition focus:border-black/25 focus:bg-white"
              >
                <option value="">All tags</option>
                {% for tag in run.all_tags %}
                <option value="{{ tag }}">{{ tag }}</option>
                {% endfor %}
              </select>
              {% endif %}
            </div>
            <div id="scenario-list" class="mt-4 space-y-3">
              {% for scenario in run.scenarios %}
              <button
                type="button"
                data-scenario-button="{{ scenario.dom_id }}"
                data-scenario-tags="{{ scenario.tags_csv }}"
                data-scenario-name="{{ scenario.nav_label|lower }}"
                data-persona="{{ scenario.persona_id|lower }}"
                data-rubric="{{ scenario.rubric_id|lower }}"
                class="scenario-nav w-full rounded-2xl border border-black/10 bg-black/[0.03] px-4 py-3 text-left transition hover:border-black/20 hover:bg-black/[0.05]"
              >
                <div class="flex items-start justify-between gap-3">
                  <div class="min-w-0">
                    <div class="text-sm font-semibold scenario-label">{{ scenario.nav_label }}</div>
                    <div class="mt-1 text-xs scenario-meta text-black/55">{{ scenario.persona_id }} • {{ scenario.rubric_id }}</div>
                  </div>
                  <div data-tone="{{ scenario.status_tone }}" class="scenario-badge shrink-0 rounded-full px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.2em]
                    {% if scenario.status_tone == "success" %}
                      bg-emerald-100 text-emerald-800
                    {% elif scenario.status_tone == "danger" %}
                      bg-rose-100 text-rose-800
                    {% else %}
                      bg-slate-100 text-slate-700
                    {% endif %}
                  ">
                    {{ scenario.status_label }}
                  </div>
                </div>
                {% if scenario.is_credential_error %}
                <div class="mt-2 inline-flex items-center gap-1 rounded-full bg-rose-100 px-2 py-0.5 text-[11px] font-semibold text-rose-700">
                  <svg class="h-3 w-3" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z"/></svg>
                  Credential error
                </div>
                {% endif %}
                <div class="mt-3">
                  <div class="flex items-center justify-between text-xs scenario-score text-black/55">
                    <span>Score</span>
                    <span>{{ scenario.score_label }}</span>
                  </div>
                  <div class="mt-2 h-2 rounded-full bg-black/10">
                    <div
                      class="h-2 rounded-full {% if scenario.status_tone == "success" %}bg-report-moss{% elif scenario.status_tone == "danger" %}bg-report-ember{% else %}bg-report-slate{% endif %}"
                      style="width: {{ scenario.score_percent }}%"
                    ></div>
                  </div>
                </div>
              </button>
              {% endfor %}
            </div>
            <div id="scenario-no-results" class="mt-4 hidden text-center text-sm text-black/45">No matching scenarios</div>
          </section>

          <section class="rounded-[1.75rem] border border-black/10 bg-white/80 p-5 shadow-panel backdrop-blur">
            <h2 class="font-display text-lg font-bold">Run Metadata</h2>
            <div class="mt-4 space-y-4 text-sm">
              <div>
                <div class="text-xs font-semibold uppercase tracking-[0.2em] text-black/45">Sources</div>
                <pre class="mt-2 overflow-x-auto rounded-2xl bg-black/[0.05] p-3 text-xs leading-5 text-black/70">{{ run.source_paths_pretty }}</pre>
              </div>
              <div>
                <div class="text-xs font-semibold uppercase tracking-[0.2em] text-black/45">Endpoint Snapshot</div>
                <pre class="mt-2 max-h-72 overflow-auto rounded-2xl bg-black/[0.05] p-3 text-xs leading-5 text-black/70">{{ run.endpoint_snapshot_pretty }}</pre>
              </div>
            </div>
          </section>
        </aside>

        <main>
          {% for scenario in run.scenarios %}
          <section
            data-scenario-panel="{{ scenario.dom_id }}"
            class="scenario-panel rounded-[2rem] border border-black/10 bg-white/80 p-5 shadow-panel backdrop-blur sm:p-6"
          >
            <div class="space-y-5">
              <button
                type="button"
                data-open-tab="rubric"
                data-scenario-open="{{ scenario.dom_id }}"
                class="block w-full overflow-hidden rounded-[1.75rem] border border-black/10 bg-gradient-to-r px-5 py-5 text-left transition hover:shadow-lg
                  {% if scenario.status_tone == "success" %}
                    from-report-moss to-emerald-500 text-white
                  {% elif scenario.status_tone == "danger" %}
                    from-report-ember to-orange-500 text-white
                  {% else %}
                    from-report-slate to-slate-500 text-white
                  {% endif %}
                "
              >
                <div class="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
                  <div>
                    <div class="text-xs font-semibold uppercase tracking-[0.26em] text-white/70">Score Header</div>
                    <h2 class="mt-2 font-display text-3xl font-bold">{{ scenario.scenario_name }}</h2>
                    <p class="mt-2 max-w-3xl text-sm text-white/80">
                      Click this score bar to open the rubric tab and inspect the dimension-by-dimension scoring breakdown.
                    </p>
                  </div>
                  <div class="flex flex-wrap items-end gap-6">
                    <div>
                      <div class="text-xs uppercase tracking-[0.24em] text-white/65">Overall</div>
                      <div class="mt-2 font-display text-4xl font-bold">{{ scenario.score_label }}</div>
                    </div>
                    <div>
                      <div class="text-xs uppercase tracking-[0.24em] text-white/65">Threshold</div>
                      <div class="mt-2 text-lg font-semibold">{{ scenario.threshold_label }}</div>
                    </div>
                    <div>
                      <div class="text-xs uppercase tracking-[0.24em] text-white/65">Status</div>
                      <div class="mt-2 text-lg font-semibold">{{ scenario.status_label }}</div>
                    </div>
                  </div>
                </div>
                <div class="mt-5 h-3 rounded-full bg-white/20">
                  <div class="h-3 rounded-full bg-white" style="width: {{ scenario.score_percent }}%"></div>
                </div>
              </button>

              <div class="flex flex-wrap gap-3 border-b border-black/10 pb-4">
                <button
                  type="button"
                  data-tab-button="conversation"
                  data-tab-scenario="{{ scenario.dom_id }}"
                  class="scenario-tab rounded-full border border-black/10 px-4 py-2 text-sm font-semibold transition hover:border-black/20"
                >
                  Conversation
                </button>
                <button
                  type="button"
                  data-tab-button="rubric"
                  data-tab-scenario="{{ scenario.dom_id }}"
                  class="scenario-tab rounded-full border border-black/10 px-4 py-2 text-sm font-semibold transition hover:border-black/20"
                >
                  Rubric
                </button>
              </div>

              <div data-tab-panel="conversation" data-tab-scenario="{{ scenario.dom_id }}" class="tab-panel space-y-4">
                <div class="grid gap-4 md:grid-cols-3">
                  <div class="rounded-2xl border border-black/10 bg-black/[0.03] p-4">
                    <div class="text-xs uppercase tracking-[0.2em] text-black/50">Started</div>
                    <div class="mt-2 text-sm font-semibold">{{ scenario.started_at_label }}</div>
                  </div>
                  <div class="rounded-2xl border border-black/10 bg-black/[0.03] p-4">
                    <div class="text-xs uppercase tracking-[0.2em] text-black/50">Completed</div>
                    <div class="mt-2 text-sm font-semibold">{{ scenario.completed_at_label }}</div>
                  </div>
                  <div class="rounded-2xl border border-black/10 bg-black/[0.03] p-4">
                    <div class="text-xs uppercase tracking-[0.2em] text-black/50">Counts</div>
                    <div class="mt-2 text-sm font-semibold">
                      {{ scenario.counts.turn_count }} turns • {{ scenario.counts.tool_call_count }} tool calls • {{ scenario.counts.checkpoint_count }} checkpoints
                    </div>
                  </div>
                </div>

                {% if scenario.expectations_pretty %}
                <details class="rounded-2xl border border-black/10 bg-report-sand/70 p-4">
                  <summary class="cursor-pointer text-sm font-semibold">Scenario Expectations</summary>
                  <pre class="mt-3 overflow-x-auto text-xs leading-5 text-black/70">{{ scenario.expectations_pretty }}</pre>
                </details>
                {% endif %}

                <div class="space-y-4">
                  {% for turn in scenario.turn_rows %}
                  <article class="rounded-[1.5rem] border border-black/10 p-4
                    {% if turn.tone == "assistant" %}
                      bg-emerald-50/70
                    {% elif turn.tone == "user" %}
                      bg-sky-50/80
                    {% else %}
                      bg-white
                    {% endif %}
                  ">
                    <div class="flex flex-wrap items-center justify-between gap-2">
                      <div class="flex items-center gap-3">
                        <span class="rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.24em]
                          {% if turn.tone == "assistant" %}
                            bg-emerald-100 text-emerald-800
                          {% elif turn.tone == "user" %}
                            bg-sky-100 text-sky-800
                          {% else %}
                            bg-stone-100 text-stone-700
                          {% endif %}
                        ">
                          {{ turn.role_label }}
                        </span>
                        {% if turn.source %}
                        <span class="text-xs text-black/45">{{ turn.source }}</span>
                        {% endif %}
                      </div>
                      <div class="text-xs text-black/45">Turn {{ turn.turn_index_label }} • {{ turn.created_at_label }}</div>
                    </div>

                    {% if turn.content %}
                    <div class="mt-4 whitespace-pre-wrap text-sm leading-7 text-black/80">{{ turn.content }}</div>
                    {% endif %}

                    {% if turn.tool_calls.length > 0 %}
                    <div class="mt-4 space-y-3">
                      <div class="text-xs font-semibold uppercase tracking-[0.2em] text-black/45">Tool Calls</div>
                      {% for tool in turn.tool_calls %}
                      <div class="rounded-2xl border border-black/10 bg-white/80 p-4">
                        <div class="flex items-center justify-between gap-3">
                          <div class="font-semibold">{{ tool.name }}</div>
                          <div class="text-xs text-black/45">Order {{ tool.call_order_label }}</div>
                        </div>
                        {% if tool.args_pretty %}
                        <pre class="mt-3 overflow-x-auto rounded-xl bg-black/[0.05] p-3 text-xs leading-5 text-black/70">{{ tool.args_pretty }}</pre>
                        {% endif %}
                        {% if tool.raw_pretty %}
                        <details class="mt-3">
                          <summary class="cursor-pointer text-xs font-semibold text-black/55">Raw tool record</summary>
                          <pre class="mt-2 overflow-x-auto rounded-xl bg-black/[0.05] p-3 text-xs leading-5 text-black/70">{{ tool.raw_pretty }}</pre>
                        </details>
                        {% endif %}
                      </div>
                      {% endfor %}
                    </div>
                    {% endif %}

                    {% if turn.checkpoints.length > 0 %}
                    <div class="mt-4 space-y-3">
                      <div class="text-xs font-semibold uppercase tracking-[0.2em] text-black/45">Checkpoints</div>
                      {% for checkpoint in turn.checkpoints %}
                      <div class="rounded-2xl border p-4
                        {% if checkpoint.tone == "success" %}
                          border-emerald-200 bg-emerald-50
                        {% elif checkpoint.tone == "danger" %}
                          border-rose-200 bg-rose-50
                        {% else %}
                          border-black/10 bg-white/70
                        {% endif %}
                      ">
                        <div class="flex items-center justify-between gap-3">
                          <div class="font-semibold">Checkpoint {{ checkpoint.checkpoint_index }}</div>
                          <div class="text-xs font-semibold uppercase tracking-[0.2em]">{{ checkpoint.status_label }}</div>
                        </div>
                        {% if checkpoint.failures.length > 0 %}
                        <div class="mt-3 space-y-2">
                          {% for failure in checkpoint.failures %}
                          <div class="rounded-xl bg-white/80 px-3 py-2 text-sm text-black/75">{{ failure }}</div>
                          {% endfor %}
                        </div>
                        {% endif %}
                        {% if checkpoint.assertions_pretty %}
                        <details class="mt-3">
                          <summary class="cursor-pointer text-xs font-semibold text-black/55">Assertions</summary>
                          <pre class="mt-2 overflow-x-auto rounded-xl bg-white/80 p-3 text-xs leading-5 text-black/70">{{ checkpoint.assertions_pretty }}</pre>
                        </details>
                        {% endif %}
                      </div>
                      {% endfor %}
                    </div>
                    {% endif %}

                    {% if turn.target_events.length > 0 %}
                    <div class="mt-4 space-y-3">
                      <div class="text-xs font-semibold uppercase tracking-[0.2em] text-black/45">Target Exchanges</div>
                      {% for event in turn.target_events %}
                      <details class="rounded-2xl border border-black/10 bg-white/75 p-4">
                        <summary class="cursor-pointer text-sm font-semibold">
                          Exchange {{ event.exchange_index }} • {{ event.latency_label }} ms
                        </summary>
                        {% if event.usage_pretty %}
                        <pre class="mt-3 overflow-x-auto rounded-xl bg-black/[0.05] p-3 text-xs leading-5 text-black/70">{{ event.usage_pretty }}</pre>
                        {% endif %}
                        {% if event.raw_exchange_pretty %}
                        <pre class="mt-3 overflow-x-auto rounded-xl bg-black/[0.05] p-3 text-xs leading-5 text-black/70">{{ event.raw_exchange_pretty }}</pre>
                        {% endif %}
                      </details>
                      {% endfor %}
                    </div>
                    {% endif %}
                  </article>
                  {% endfor %}
                </div>
              </div>

              <div data-tab-panel="rubric" data-tab-scenario="{{ scenario.dom_id }}" class="tab-panel hidden space-y-5">
                <div class="grid gap-4 lg:grid-cols-[1.15fr,0.85fr]">
                  <section class="rounded-[1.5rem] border border-black/10 bg-report-sand/70 p-5">
                    <div class="text-xs font-semibold uppercase tracking-[0.24em] text-black/45">Overall Notes</div>
                    {% if scenario.overall_notes %}
                    <div class="mt-3 whitespace-pre-wrap text-sm leading-7 text-black/75">{{ scenario.overall_notes }}</div>
                    {% else %}
                    <div class="mt-3 text-sm text-black/55">No overall notes were recorded.</div>
                    {% endif %}
                  </section>
                  <section class="rounded-[1.5rem] border border-black/10 bg-black/[0.03] p-5">
                    <div class="text-xs font-semibold uppercase tracking-[0.24em] text-black/45">Judge</div>
                    <div class="mt-3 space-y-2 text-sm text-black/70">
                      <div><span class="font-semibold text-black/80">Provider:</span> {{ scenario.judge.provider or "n/a" }}</div>
                      <div><span class="font-semibold text-black/80">Model:</span> {{ scenario.judge.model or "n/a" }}</div>
                      <div><span class="font-semibold text-black/80">Temperature:</span> {{ scenario.judge.temperature_label }}</div>
                      <div><span class="font-semibold text-black/80">Max Tokens:</span> {{ scenario.judge.max_tokens_label }}</div>
                    </div>
                  </section>
                </div>

                {% if scenario.dimension_rows.length > 0 %}
                <div class="grid gap-4 lg:grid-cols-2">
                  {% for dimension in scenario.dimension_rows %}
                  <section class="rounded-[1.5rem] border border-black/10 bg-white p-5">
                    <div class="flex items-start justify-between gap-4">
                      <div>
                        <h3 class="font-display text-xl font-bold">{{ dimension.dimension_name }}</h3>
                        <div class="mt-1 text-xs uppercase tracking-[0.2em] text-black/45">{{ dimension.dimension_id }}</div>
                      </div>
                      <div class="text-right">
                        <div class="font-display text-2xl font-bold">{{ dimension.raw_score_label }}{% if dimension.has_scale_points %}/{{ dimension.scale_points_label }}{% endif %}</div>
                        <div class="text-xs text-black/45">Weight {{ dimension.weight_label }}</div>
                      </div>
                    </div>
                    <div class="mt-4 h-3 rounded-full bg-black/10">
                      <div class="h-3 rounded-full bg-report-slate" style="width: {{ dimension.percent }}%"></div>
                    </div>
                    <div class="mt-4 whitespace-pre-wrap text-sm leading-7 text-black/75">{{ dimension.reasoning }}</div>
                    {% if dimension.evidence.length > 0 %}
                    <div class="mt-4 space-y-2">
                      <div class="text-xs font-semibold uppercase tracking-[0.2em] text-black/45">Evidence</div>
                      {% for item in dimension.evidence %}
                      <div class="rounded-xl bg-black/[0.04] px-3 py-2 text-sm text-black/75">{{ item }}</div>
                      {% endfor %}
                    </div>
                    {% endif %}
                  </section>
                  {% endfor %}
                </div>
                {% else %}
                <section class="rounded-[1.5rem] border border-black/10 bg-white p-5">
                  <div class="text-sm text-black/60">No rubric dimension scores were recorded for this scenario.</div>
                </section>
                {% endif %}

                {% if scenario.error_pretty %}
                <details class="rounded-[1.5rem] border border-rose-200 bg-rose-50 p-5">
                  <summary class="cursor-pointer text-sm font-semibold text-rose-800">Scenario Error</summary>
                  <pre class="mt-3 overflow-x-auto rounded-xl bg-white/80 p-3 text-xs leading-5 text-rose-900">{{ scenario.error_pretty }}</pre>
                </details>
                {% endif %}

                {% if scenario.judge_output_pretty %}
                <details class="rounded-[1.5rem] border border-black/10 bg-white p-5">
                  <summary class="cursor-pointer text-sm font-semibold">Raw Judge Output</summary>
                  <pre class="mt-3 overflow-x-auto rounded-xl bg-black/[0.05] p-3 text-xs leading-5 text-black/70">{{ scenario.judge_output_pretty }}</pre>
                </details>
                {% endif %}
              </div>
            </div>
          </section>
          {% endfor %}
        </main>
      </div>
    </div>

    <script>
      const scenarioButtons = [...document.querySelectorAll("[data-scenario-button]")];
      const scenarioPanels = [...document.querySelectorAll("[data-scenario-panel]")];
      const tabButtons = [...document.querySelectorAll("[data-tab-button]")];
      const tabPanels = [...document.querySelectorAll("[data-tab-panel]")];
      const scoreOpeners = [...document.querySelectorAll("[data-open-tab]")];
      const defaultScenario = scenarioPanels[0]?.dataset.scenarioPanel;

      const searchInput = document.getElementById("scenario-search");
      const tagFilter = document.getElementById("scenario-tag-filter");
      const noResults = document.getElementById("scenario-no-results");

      function updateScenarioNav(activeScenario) {
        scenarioButtons.forEach((button) => {
          const active = button.dataset.scenarioButton === activeScenario;
          button.classList.toggle("bg-report-ink", active);
          button.classList.toggle("text-white", active);
          button.classList.toggle("border-transparent", active);
          button.classList.toggle("shadow-lg", active);

          button.querySelectorAll(".scenario-meta, .scenario-score").forEach((el) => {
            el.classList.toggle("text-black/55", !active);
            el.classList.toggle("text-white/70", active);
          });
          button.querySelectorAll(".scenario-label").forEach((el) => {
            el.classList.toggle("text-white", active);
          });
          button.querySelectorAll(".scenario-badge").forEach((el) => {
            if (active) {
              el.classList.add("bg-white/20", "text-white");
              el.classList.remove("bg-emerald-100", "text-emerald-800", "bg-rose-100", "text-rose-800", "bg-slate-100", "text-slate-700");
            } else {
              el.classList.remove("bg-white/20", "text-white");
              const tone = el.dataset.tone;
              if (tone === "success") {
                el.classList.add("bg-emerald-100", "text-emerald-800");
              } else if (tone === "danger") {
                el.classList.add("bg-rose-100", "text-rose-800");
              } else {
                el.classList.add("bg-slate-100", "text-slate-700");
              }
            }
          });
        });
      }

      function updateScenarioPanels(activeScenario) {
        scenarioPanels.forEach((panel) => {
          panel.classList.toggle("hidden", panel.dataset.scenarioPanel !== activeScenario);
        });
      }

      function setTab(activeScenario, activeTab) {
        tabButtons.forEach((button) => {
          const active =
            button.dataset.tabScenario === activeScenario &&
            button.dataset.tabButton === activeTab;
          button.classList.toggle("bg-report-ink", active);
          button.classList.toggle("text-white", active);
          button.classList.toggle("border-transparent", active);
        });

        tabPanels.forEach((panel) => {
          const active =
            panel.dataset.tabScenario === activeScenario &&
            panel.dataset.tabPanel === activeTab;
          panel.classList.toggle("hidden", !active);
        });
      }

      function setScenario(activeScenario, preferredTab = "conversation") {
        updateScenarioNav(activeScenario);
        updateScenarioPanels(activeScenario);
        setTab(activeScenario, preferredTab);
      }

      function filterScenarios() {
        const query = (searchInput?.value || "").toLowerCase().trim();
        const selectedTag = tagFilter?.value || "";
        let visibleCount = 0;

        scenarioButtons.forEach((button) => {
          const name = button.dataset.scenarioName || "";
          const persona = button.dataset.persona || "";
          const rubric = button.dataset.rubric || "";
          const tags = button.dataset.scenarioTags || "";

          const matchesSearch = !query ||
            name.includes(query) ||
            persona.includes(query) ||
            rubric.includes(query) ||
            tags.toLowerCase().includes(query);

          const matchesTag = !selectedTag || tags.split(",").includes(selectedTag);

          const visible = matchesSearch && matchesTag;
          button.classList.toggle("hidden", !visible);
          if (visible) {
            visibleCount += 1;
          }
        });

        if (noResults) {
          noResults.classList.toggle("hidden", visibleCount > 0);
        }
      }

      if (searchInput) searchInput.addEventListener("input", filterScenarios);
      if (tagFilter) tagFilter.addEventListener("change", filterScenarios);

      scenarioButtons.forEach((button) => {
        button.addEventListener("click", () => setScenario(button.dataset.scenarioButton));
      });

      tabButtons.forEach((button) => {
        button.addEventListener("click", () => {
          setScenario(button.dataset.tabScenario, button.dataset.tabButton);
        });
      });

      scoreOpeners.forEach((button) => {
        button.addEventListener("click", () => {
          setScenario(button.dataset.scenarioOpen, button.dataset.openTab);
        });
      });

      if (defaultScenario) {
        setScenario(defaultScenario, "conversation");
      }
    </script>
  </body>
</html>
`;

export function renderRunReport(run: RunRecord): string {
  return reportEnvironment.renderString(REPORT_TEMPLATE, {
    run: prepareRunView(run),
  });
}

function discoverDbUrls(searchRoot?: string): string[] {
  const root = resolve(searchRoot ?? invocationCwd());
  if (!existsSync(root)) {
    return [];
  }

  const candidates: string[] = [];

  const direct = join(root, DEFAULT_DB_DIRNAME, DEFAULT_DB_FILENAME);
  if (existsSync(direct)) {
    candidates.push(direct);
  }

  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (
        entry.isFile() &&
        entry.name === DEFAULT_DB_FILENAME &&
        directory.endsWith(`/${DEFAULT_DB_DIRNAME}`)
      ) {
        candidates.push(path);
      }
    }
  };
  walk(root);

  return [...new Set(candidates.map((path) => `sqlite:///${resolve(path)}`))];
}

function chooseLatestDiscoveredRun(searchRoot?: string):
  | { dbUrl: string; runId: string; startedAt: string }
  | undefined {
  let best:
    | { dbUrl: string; runId: string; startedAt: string }
    | undefined;

  for (const dbUrl of discoverDbUrls(searchRoot)) {
    const runs = listRuns({ dbUrl });
    for (const run of runs) {
      if (
        !best ||
        timestampSortKey(run.startedAt) > timestampSortKey(best.startedAt)
      ) {
        best = { dbUrl, runId: run.runId, startedAt: run.startedAt };
      }
    }
  }

  return best;
}

export function writeRunReport(options: {
  runId?: string;
  outputPath?: string;
  dbUrl?: string;
  searchRoot?: string;
} = {}): string {
  let dbUrl = options.dbUrl;
  let runId = options.runId;

  if (!dbUrl) {
    const discovered = chooseLatestDiscoveredRun(options.searchRoot);
    if (!discovered) {
      throw new AgentProbeRuntimeError("No recorded runs were found.");
    }
    dbUrl = discovered.dbUrl;
    runId ??= discovered.runId;
  } else if (!runId) {
    const runs = listRuns({ dbUrl });
    runId = runs[0]?.runId;
  }

  if (!runId || !dbUrl) {
    throw new AgentProbeRuntimeError("No recorded runs were found.");
  }

  const run = getRun(runId, { dbUrl });
  if (!run) {
    throw new AgentProbeRuntimeError(`Run ${runId} was not found.`);
  }

  const outputPath =
    options.outputPath ??
    resolve(
      options.searchRoot ?? invocationCwd(),
      `agentprobe-report-${runId}.html`,
    );
  writeFileSync(outputPath, renderRunReport(run), "utf8");
  return resolve(outputPath);
}

export { discoverDbUrls };

import { existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import { getRun } from "../../providers/persistence/sqlite-run-history.ts";
import type {
  JsonValue,
  RunProgressEvent,
  ScenarioRecord,
} from "../../shared/types/contracts.ts";
import {
  logDebug,
  logInfo,
  logWarn,
} from "../../shared/utils/logging.ts";

export type DashboardScenarioState = {
  scenario_id: string;
  scenario_name: string | null;
  status: "pending" | "running" | "pass" | "fail" | "error";
  score: number | null;
  error: string | null;
  started_at: number | null;
  finished_at: number | null;
};

export type DashboardScenarioDetail = {
  scenario_id: string;
  scenario_name: string;
  user_id?: string;
  passed: boolean;
  overall_score: number | null;
  pass_threshold: number | null;
  status: string;
  judge?: {
    provider?: string;
    model?: string;
    temperature?: number;
    max_tokens?: number;
    overall_notes?: string;
    output?: Record<string, unknown>;
  };
  turns?: Array<Record<string, JsonValue>>;
  tool_calls?: Array<Record<string, JsonValue>>;
  checkpoints?: Array<Record<string, JsonValue>>;
  judge_dimension_scores?: Array<Record<string, JsonValue>>;
  expectations?: unknown;
  error?: unknown;
  counts?: {
    turn_count: number;
    assistant_turn_count: number;
    tool_call_count: number;
    checkpoint_count: number;
  };
};

export type DashboardAverage = {
  base_id: string;
  scenario_name: string | null;
  avg: number;
  min: number;
  max: number;
  spread: number;
  n: number;
  pass_count: number;
  fail_count: number;
  dimensions: Array<{
    dimension_id: string;
    dimension_name: string;
    avg: number;
    min: number;
    max: number;
    n: number;
  }>;
  failure_modes: Record<string, number>;
  judge_notes: string[];
  ordinals: number[];
};

export type DashboardStateSnapshot = {
  total: number;
  elapsed: number;
  passed: number;
  failed: number;
  errored: number;
  running: number;
  done: number;
  all_done: boolean;
  scenarios: DashboardScenarioState[];
  details: Record<number, DashboardScenarioDetail>;
  averages: DashboardAverage[];
};

type PrimeScenario = {
  ordinal: number;
  displayId: string;
  scenarioName?: string | null;
};

type AverageAccumulator = {
  baseId: string;
  scenarioName: string | null;
  firstOrdinal: number;
  scores: number[];
  passCount: number;
  failCount: number;
  dimensions: Map<
    string,
    { dimensionName: string; values: number[] }
  >;
  failureModes: Map<string, number>;
  judgeNotes: string[];
  ordinals: number[];
};

export const DEFAULT_DASHBOARD_HOST = "127.0.0.1";
export const DEFAULT_DASHBOARD_DIST_DIR = resolve(
  import.meta.dir,
  "..",
  "..",
  "..",
  "dashboard",
  "dist",
);

function nowSeconds(): number {
  return Date.now() / 1000;
}

function parseTimestamp(value?: string | null): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return null;
  }
  return parsed / 1000;
}

function displayStatus(
  record: ScenarioRecord,
): DashboardScenarioState["status"] {
  if (record.status === "running") {
    return "running";
  }
  if (record.status === "completed") {
    return record.passed ? "pass" : "fail";
  }
  return "error";
}

function extractErrorMessage(record: ScenarioRecord): string | null {
  if (
    record.error &&
    typeof record.error === "object" &&
    !Array.isArray(record.error) &&
    typeof record.error.message === "string"
  ) {
    return record.error.message;
  }
  return null;
}

function repeatBaseId(value: string): string {
  return value.replace(/#\d+$/, "");
}

function average(values: number[]): number {
  return values.reduce((sum, item) => sum + item, 0) / values.length;
}

function parseFailureMode(record: ScenarioRecord): string | undefined {
  const output = record.judge.output;
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return undefined;
  }
  const failureMode = (output as Record<string, unknown>).failure_mode_detected;
  return typeof failureMode === "string" && failureMode.trim()
    ? failureMode
    : undefined;
}

function mapScenarioDetail(
  record: ScenarioRecord,
  displayId: string,
): DashboardScenarioDetail {
  return {
    scenario_id: displayId,
    scenario_name: record.scenarioName,
    user_id: record.userId ?? undefined,
    passed: record.passed === true,
    overall_score: record.overallScore ?? null,
    pass_threshold: record.passThreshold ?? null,
    status: record.status,
    judge: {
      provider: record.judge.provider ?? undefined,
      model: record.judge.model ?? undefined,
      temperature: record.judge.temperature ?? undefined,
      max_tokens: record.judge.maxTokens ?? undefined,
      overall_notes: record.judge.overallNotes ?? undefined,
      output:
        record.judge.output &&
        typeof record.judge.output === "object" &&
        !Array.isArray(record.judge.output)
          ? (record.judge.output as Record<string, unknown>)
          : undefined,
    },
    turns: record.turns,
    tool_calls: record.toolCalls,
    checkpoints: record.checkpoints,
    judge_dimension_scores: record.judgeDimensionScores,
    expectations: record.expectations,
    error: record.error ?? undefined,
    counts: {
      turn_count: record.counts.turnCount,
      assistant_turn_count: record.counts.assistantTurnCount,
      tool_call_count: record.counts.toolCallCount,
      checkpoint_count: record.counts.checkpointCount,
    },
  };
}

function buildAverages(
  scenarios: ScenarioRecord[],
  displayIds: Map<number, string>,
): DashboardAverage[] {
  const groups = new Map<string, AverageAccumulator>();

  for (const scenario of scenarios) {
    const displayId = displayIds.get(scenario.ordinal) ?? scenario.scenarioId;
    const baseId = repeatBaseId(displayId);
    const existing = groups.get(baseId);
    const group =
      existing ??
      ({
        baseId,
        scenarioName: scenario.scenarioName,
        firstOrdinal: scenario.ordinal,
        scores: [] as number[],
        passCount: 0,
        failCount: 0,
        dimensions: new Map<string, { dimensionName: string; values: number[] }>(),
        failureModes: new Map<string, number>(),
        judgeNotes: [] as string[],
        ordinals: [] as number[],
      }) satisfies AverageAccumulator;

    if (!existing) {
      groups.set(baseId, group);
    }

    group.firstOrdinal = Math.min(group.firstOrdinal, scenario.ordinal);
    group.scenarioName ??= scenario.scenarioName;
    if (typeof scenario.overallScore === "number") {
      group.scores.push(scenario.overallScore);
    }
    if (scenario.passed === true) {
      group.passCount += 1;
    } else if (scenario.passed === false) {
      group.failCount += 1;
    }

    const failureMode = parseFailureMode(scenario);
    if (failureMode) {
      group.failureModes.set(
        failureMode,
        (group.failureModes.get(failureMode) ?? 0) + 1,
      );
    }

    if (
      typeof scenario.judge.overallNotes === "string" &&
      scenario.judge.overallNotes.trim() &&
      !group.judgeNotes.includes(scenario.judge.overallNotes)
    ) {
      group.judgeNotes.push(scenario.judge.overallNotes);
    }

    if (!group.ordinals.includes(scenario.ordinal)) {
      group.ordinals.push(scenario.ordinal);
    }

    for (const dimension of scenario.judgeDimensionScores) {
      const id =
        typeof dimension.dimension_id === "string"
          ? dimension.dimension_id
          : undefined;
      const name =
        typeof dimension.dimension_name === "string"
          ? dimension.dimension_name
          : undefined;
      const normalized =
        typeof dimension.normalized_score === "number"
          ? dimension.normalized_score
          : undefined;
      if (!id || !name || normalized === undefined) {
        continue;
      }
      const dimensionBucket = group.dimensions.get(id) ?? {
        dimensionName: name,
        values: [],
      };
      dimensionBucket.values.push(normalized);
      group.dimensions.set(id, dimensionBucket);
    }
  }

  return [...groups.values()]
    .sort((left, right) => left.firstOrdinal - right.firstOrdinal)
    .map((group) => {
      const scores = group.scores.length > 0 ? group.scores : [0];
      const min = Math.min(...scores);
      const max = Math.max(...scores);
      return {
        base_id: group.baseId,
        scenario_name: group.scenarioName,
        avg: average(scores),
        min,
        max,
        spread: max - min,
        n: group.scores.length,
        pass_count: group.passCount,
        fail_count: group.failCount,
        dimensions: [...group.dimensions.entries()]
          .map(([dimensionId, bucket]) => ({
            dimension_id: dimensionId,
            dimension_name: bucket.dimensionName,
            avg: average(bucket.values),
            min: Math.min(...bucket.values),
            max: Math.max(...bucket.values),
            n: bucket.values.length,
          }))
          .sort((left, right) =>
            left.dimension_name.localeCompare(right.dimension_name),
          ),
        failure_modes: Object.fromEntries(group.failureModes),
        judge_notes: group.judgeNotes,
        ordinals: [...group.ordinals].sort((left, right) => left - right),
      };
    })
    .filter((group) => group.n > 0);
}

export class LiveDashboardState {
  private readonly displayIds = new Map<number, string>();
  private readonly scenarioNames = new Map<number, string | null>();
  private readonly details = new Map<number, DashboardScenarioDetail>();
  private scenarios: DashboardScenarioState[] = [];
  private averages: DashboardAverage[] = [];
  private runId?: string | null;
  private total = 0;
  private startedAt?: number;
  private completedAt?: number;

  constructor(private readonly dbUrl?: string) {}

  primeScenarios(entries: PrimeScenario[]): void {
    if (entries.length === 0) {
      return;
    }
    this.total = Math.max(this.total, entries.length);
    this.ensureScenarioCapacity(this.total);
    for (const entry of entries) {
      this.displayIds.set(entry.ordinal, entry.displayId);
      this.scenarioNames.set(entry.ordinal, entry.scenarioName ?? null);
      this.scenarios[entry.ordinal] = {
        scenario_id: entry.displayId,
        scenario_name: entry.scenarioName ?? null,
        status: "pending",
        score: null,
        error: null,
        started_at: null,
        finished_at: null,
      };
    }
  }

  handleProgress(event: RunProgressEvent): void {
    if (event.runId !== undefined) {
      this.runId = event.runId;
    }

    if (event.kind === "suite_started") {
      this.startedAt ??= nowSeconds();
      this.total = Math.max(this.total, event.scenarioTotal ?? 0);
      this.ensureScenarioCapacity(this.total);
      return;
    }

    const ordinal =
      typeof event.scenarioIndex === "number" ? event.scenarioIndex - 1 : null;
    if (ordinal === null || ordinal < 0) {
      return;
    }

    this.ensureScenarioCapacity(Math.max(this.total, ordinal + 1));
    const displayId = event.scenarioId ?? `scenario-${ordinal + 1}`;
    const scenarioName = event.scenarioName ?? this.scenarioNames.get(ordinal) ?? null;
    this.displayIds.set(ordinal, displayId);
    this.scenarioNames.set(ordinal, scenarioName);

    if (event.kind === "scenario_started") {
      this.scenarios[ordinal] = {
        scenario_id: displayId,
        scenario_name: scenarioName,
        status: "running",
        score: null,
        error: null,
        started_at: nowSeconds(),
        finished_at: null,
      };
      logDebug("Dashboard scenario started", displayId);
      return;
    }

    if (event.kind === "scenario_finished") {
      const current = this.scenarios[ordinal];
      this.scenarios[ordinal] = {
        scenario_id: displayId,
        scenario_name: scenarioName,
        status: event.passed ? "pass" : "fail",
        score:
          typeof event.overallScore === "number" ? event.overallScore : null,
        error: null,
        started_at: current?.started_at ?? nowSeconds(),
        finished_at: nowSeconds(),
      };
      this.refreshFromDb();
      return;
    }

    if (event.kind === "scenario_error") {
      const current = this.scenarios[ordinal];
      this.scenarios[ordinal] = {
        scenario_id: displayId,
        scenario_name: scenarioName,
        status: "error",
        score: null,
        error: event.error?.message ?? "Unknown error",
        started_at: current?.started_at ?? nowSeconds(),
        finished_at: nowSeconds(),
      };
      this.refreshFromDb();
    }
  }

  snapshot(): DashboardStateSnapshot {
    this.refreshFromDb();
    const scenarios = this.scenarios.slice(0, this.total);
    const passed = scenarios.filter((scenario) => scenario.status === "pass").length;
    const failed = scenarios.filter((scenario) => scenario.status === "fail").length;
    const errored = scenarios.filter((scenario) => scenario.status === "error").length;
    const running = scenarios.filter((scenario) => scenario.status === "running").length;
    const done = passed + failed + errored;
    const allDone =
      this.completedAt !== undefined || (this.total > 0 && done >= this.total);
    const startedAt = this.startedAt ?? nowSeconds();
    const elapsed = Math.max(
      0,
      (allDone ? this.completedAt ?? startedAt : nowSeconds()) - startedAt,
    );

    return {
      total: this.total,
      elapsed,
      passed,
      failed,
      errored,
      running,
      done,
      all_done: allDone,
      scenarios,
      details: Object.fromEntries(this.details),
      averages: this.averages,
    };
  }

  private ensureScenarioCapacity(total: number): void {
    this.total = Math.max(this.total, total);
    while (this.scenarios.length < this.total) {
      const ordinal = this.scenarios.length;
      this.scenarios.push({
        scenario_id: this.displayIds.get(ordinal) ?? `scenario-${ordinal + 1}`,
        scenario_name: this.scenarioNames.get(ordinal) ?? null,
        status: "pending",
        score: null,
        error: null,
        started_at: null,
        finished_at: null,
      });
    }
  }

  private refreshFromDb(): void {
    if (!this.runId || !this.dbUrl) {
      return;
    }

    const run = getRun(this.runId, { dbUrl: this.dbUrl });
    if (!run) {
      return;
    }

    this.startedAt ??= parseTimestamp(run.startedAt) ?? nowSeconds();
    if (run.completedAt) {
      this.completedAt = parseTimestamp(run.completedAt) ?? this.completedAt;
    }
    this.total = Math.max(
      this.total,
      run.aggregateCounts.scenarioTotal,
      run.scenarios.length,
    );
    this.ensureScenarioCapacity(this.total);

    for (const scenario of run.scenarios) {
      const displayId =
        this.displayIds.get(scenario.ordinal) ?? scenario.scenarioId;
      const scenarioName =
        this.scenarioNames.get(scenario.ordinal) ?? scenario.scenarioName;
      this.displayIds.set(scenario.ordinal, displayId);
      this.scenarioNames.set(scenario.ordinal, scenarioName);
      this.scenarios[scenario.ordinal] = {
        scenario_id: displayId,
        scenario_name: scenarioName,
        status: displayStatus(scenario),
        score: scenario.overallScore ?? null,
        error: extractErrorMessage(scenario),
        started_at: parseTimestamp(scenario.startedAt),
        finished_at: parseTimestamp(scenario.completedAt),
      };
      this.details.set(
        scenario.ordinal,
        mapScenarioDetail(scenario, displayId),
      );
    }

    this.averages = buildAverages(run.scenarios, this.displayIds);
  }
}

export type DashboardServerHandle = {
  readonly url: string;
  readonly state: LiveDashboardState;
  stop: () => void;
};

function safeStaticPath(distDir: string, pathname: string): string | undefined {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const candidate = resolve(distDir, relative);
  if (candidate === distDir || candidate.startsWith(`${distDir}${sep}`)) {
    return candidate;
  }
  return undefined;
}

export function startDashboardServer(options: {
  dbUrl?: string;
  distDir?: string;
  hostname?: string;
  port?: number;
} = {}): DashboardServerHandle | undefined {
  const distDir = resolve(options.distDir ?? DEFAULT_DASHBOARD_DIST_DIR);
  const entryPath = join(distDir, "index.html");
  if (!existsSync(entryPath)) {
    logWarn(
      `Dashboard build not found at ${entryPath}. Continuing without --dashboard output.`,
    );
    return undefined;
  }

  const hostname = options.hostname ?? DEFAULT_DASHBOARD_HOST;
  const state = new LiveDashboardState(options.dbUrl);
  const server = Bun.serve({
    hostname,
    port: options.port ?? 0,
    fetch: (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/state") {
        return Response.json(state.snapshot());
      }

      const filePath = safeStaticPath(distDir, url.pathname);
      if (!filePath || !existsSync(filePath)) {
        return new Response("Not found", { status: 404 });
      }

      return new Response(Bun.file(filePath));
    },
  });

  const serverUrl = `http://${hostname}:${server.port}`;
  logInfo(`Dashboard server listening on ${serverUrl}`);
  logDebug("Dashboard dist dir", distDir);

  return {
    url: serverUrl,
    state,
    stop() {
      logDebug("Stopping dashboard server");
      server.stop(true);
    },
  };
}

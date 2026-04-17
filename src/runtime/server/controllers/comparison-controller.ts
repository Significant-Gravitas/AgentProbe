import type { ReadableRepository } from "../../../providers/persistence/types.ts";
import type {
  JsonValue,
  RunRecord,
  ScenarioRecord,
} from "../../../shared/types/contracts.ts";
import { HttpInputError } from "../validation.ts";

export const MIN_COMPARISON_RUNS = 2;
export const MAX_COMPARISON_RUNS = 10;
const RUN_ID_PATTERN =
  /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export type ComparisonAlignment =
  | "preset_snapshot"
  | "preset_id"
  | "scenario_id"
  | "file_scenario_id";

export type ComparisonScenarioStatus =
  | "pass"
  | "fail"
  | "harness_fail"
  | "error"
  | "missing"
  | "running";

export type ComparisonRunSummary = {
  run_id: string;
  status: string;
  passed: boolean | null;
  label: string | null;
  preset_id: string | null;
  preset_snapshot_fingerprint: string | null;
  started_at: string;
  completed_at: string | null;
  scenario_total: number;
  scenario_passed_count: number;
  scenario_failed_count: number;
  scenario_harness_failed_count: number;
  scenario_errored_count: number;
};

export type ComparisonScenarioEntry = {
  run_id: string;
  status: ComparisonScenarioStatus;
  score: number | null;
  reason: string | null;
};

export type ComparisonScenarioRow = {
  alignment_key: string;
  file: string | null;
  scenario_id: string;
  scenario_name: string | null;
  present_in: string[];
  entries: Record<string, ComparisonScenarioEntry>;
  delta_score: number | null;
  status_change: "unchanged" | "regressed" | "improved" | "mixed";
};

export type ComparisonSummary = {
  total_scenarios: number;
  scenarios_changed: number;
  scenarios_regressed: number;
  scenarios_improved: number;
  scenarios_missing_in_some: number;
  average_score_delta: number | null;
};

export type ComparisonPayload = {
  alignment: ComparisonAlignment;
  runs: ComparisonRunSummary[];
  scenarios: ComparisonScenarioRow[];
  summary: ComparisonSummary;
};

function jsonStableStringify(value: JsonValue | undefined | null): string {
  if (value === undefined) {
    return "null";
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => jsonStableStringify(item as JsonValue)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys
    .map(
      (key) =>
        `${JSON.stringify(key)}:${jsonStableStringify((value as Record<string, JsonValue>)[key] ?? null)}`,
    )
    .join(",")}}`;
}

function presetSnapshotFingerprint(run: RunRecord): string | null {
  if (!run.presetSnapshot) {
    return null;
  }
  const snapshot = run.presetSnapshot as Record<string, JsonValue>;
  const stable: Record<string, JsonValue> = {
    endpoint: (snapshot.endpoint as JsonValue) ?? null,
    personas: (snapshot.personas as JsonValue) ?? null,
    rubric: (snapshot.rubric as JsonValue) ?? null,
    selection: (snapshot.selection as JsonValue) ?? null,
  };
  return jsonStableStringify(stable);
}

function scenarioStatus(
  scenario: ScenarioRecord,
): Exclude<ComparisonScenarioStatus, "missing"> {
  if (scenario.status === "running") {
    return "running";
  }
  if (scenario.status === "runtime_error" || scenario.status === "error") {
    return "error";
  }
  if (scenario.passed === true) {
    return "pass";
  }
  if (scenario.failureKind === "harness") {
    return "harness_fail";
  }
  return "fail";
}

function scenarioReason(scenario: ScenarioRecord): string | null {
  if (scenario.error && typeof scenario.error === "object") {
    const message = (scenario.error as Record<string, JsonValue>).message;
    if (typeof message === "string") {
      return message;
    }
  }
  if (scenario.judge.overallNotes) {
    return scenario.judge.overallNotes;
  }
  return null;
}

function runSummary(run: RunRecord): ComparisonRunSummary {
  return {
    run_id: run.runId,
    status: run.status,
    passed: run.passed ?? null,
    label: run.label ?? null,
    preset_id: run.presetId ?? null,
    preset_snapshot_fingerprint: presetSnapshotFingerprint(run),
    started_at: run.startedAt,
    completed_at: run.completedAt ?? null,
    scenario_total: run.aggregateCounts.scenarioTotal,
    scenario_passed_count: run.aggregateCounts.scenarioPassedCount,
    scenario_failed_count: run.aggregateCounts.scenarioFailedCount,
    scenario_harness_failed_count:
      run.aggregateCounts.scenarioHarnessFailedCount,
    scenario_errored_count: run.aggregateCounts.scenarioErroredCount,
  };
}

function scenarioFileHint(scenario: ScenarioRecord): string | null {
  const snapshot = scenario.scenarioSnapshot as
    | Record<string, JsonValue>
    | undefined;
  if (!snapshot) {
    return null;
  }
  const candidates: Array<JsonValue | undefined> = [
    snapshot.sourceFile as JsonValue | undefined,
    snapshot.source_file as JsonValue | undefined,
    snapshot.file as JsonValue | undefined,
    snapshot.filePath as JsonValue | undefined,
    (snapshot.metadata as Record<string, JsonValue> | undefined)?.file,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate) {
      return candidate;
    }
  }
  return null;
}

export function chooseAlignment(runs: RunRecord[]): {
  alignment: ComparisonAlignment;
  fingerprints: Map<string, string | null>;
} {
  const fingerprints = new Map<string, string | null>();
  for (const run of runs) {
    fingerprints.set(run.runId, presetSnapshotFingerprint(run));
  }
  const allSnapshotsPresent = [...fingerprints.values()].every(
    (value) => value !== null,
  );
  const uniqueSnapshots = new Set(
    [...fingerprints.values()].filter(
      (value): value is string => value !== null,
    ),
  );
  if (allSnapshotsPresent && uniqueSnapshots.size === 1) {
    return { alignment: "preset_snapshot", fingerprints };
  }

  const presetIds = runs.map((run) => run.presetId ?? null);
  const allPresetIdsPresent = presetIds.every((value) => value !== null);
  if (
    allPresetIdsPresent &&
    new Set(presetIds.filter((value): value is string => value !== null))
      .size === 1
  ) {
    return { alignment: "preset_id", fingerprints };
  }

  // Default: scenario id, unless we detect duplicates across files within any run.
  for (const run of runs) {
    const seen = new Map<string, ScenarioRecord>();
    for (const scenario of run.scenarios) {
      const existing = seen.get(scenario.scenarioId);
      if (
        existing &&
        scenarioFileHint(existing) !== scenarioFileHint(scenario)
      ) {
        return { alignment: "file_scenario_id", fingerprints };
      }
      seen.set(scenario.scenarioId, scenario);
    }
  }
  return { alignment: "scenario_id", fingerprints };
}

function alignmentKey(
  scenario: ScenarioRecord,
  alignment: ComparisonAlignment,
): { key: string; file: string | null } {
  if (alignment === "file_scenario_id") {
    const file = scenarioFileHint(scenario) ?? "__unknown__";
    return { key: `${file}::${scenario.scenarioId}`, file };
  }
  return { key: scenario.scenarioId, file: scenarioFileHint(scenario) };
}

export function buildComparisonPayload(runs: RunRecord[]): ComparisonPayload {
  const { alignment } = chooseAlignment(runs);

  const runIds = runs.map((run) => run.runId);
  const rowsByKey = new Map<
    string,
    {
      file: string | null;
      scenarioId: string;
      scenarioName: string | null;
      perRun: Map<string, ScenarioRecord>;
    }
  >();

  for (const run of runs) {
    for (const scenario of run.scenarios) {
      const { key, file } = alignmentKey(scenario, alignment);
      const entry = rowsByKey.get(key);
      if (entry) {
        entry.perRun.set(run.runId, scenario);
      } else {
        rowsByKey.set(key, {
          file,
          scenarioId: scenario.scenarioId,
          scenarioName: scenario.scenarioName ?? null,
          perRun: new Map([[run.runId, scenario]]),
        });
      }
    }
  }

  const scenarios: ComparisonScenarioRow[] = [];
  let totalDelta = 0;
  let totalDeltaCount = 0;
  let scenariosChanged = 0;
  let scenariosRegressed = 0;
  let scenariosImproved = 0;
  let scenariosMissing = 0;

  for (const [key, info] of rowsByKey) {
    const entries: Record<string, ComparisonScenarioEntry> = {};
    const presentIn: string[] = [];
    const scores: number[] = [];
    const statuses: ComparisonScenarioStatus[] = [];

    for (const runId of runIds) {
      const scenario = info.perRun.get(runId);
      if (!scenario) {
        entries[runId] = {
          run_id: runId,
          status: "missing",
          score: null,
          reason: null,
        };
        statuses.push("missing");
        continue;
      }
      presentIn.push(runId);
      const status = scenarioStatus(scenario);
      statuses.push(status);
      const score =
        typeof scenario.overallScore === "number"
          ? scenario.overallScore
          : null;
      if (score !== null) {
        scores.push(score);
      }
      entries[runId] = {
        run_id: runId,
        status,
        score,
        reason: scenarioReason(scenario),
      };
    }

    let deltaScore: number | null = null;
    if (scores.length >= 2) {
      const firstValid = scores[0];
      const lastValid = scores[scores.length - 1];
      if (firstValid !== undefined && lastValid !== undefined) {
        deltaScore = lastValid - firstValid;
        totalDelta += deltaScore;
        totalDeltaCount += 1;
      }
    }

    const statusesWithoutMissing = statuses.filter(
      (status) => status !== "missing",
    );
    const allSameStatus =
      new Set(statusesWithoutMissing).size <= 1 &&
      !statuses.includes("missing");
    const firstValidStatus = statuses.find((status) => status !== "missing");
    const lastValidStatus = [...statuses]
      .reverse()
      .find((status) => status !== "missing");
    let statusChange: ComparisonScenarioRow["status_change"] = "unchanged";
    if (statuses.includes("missing")) {
      statusChange = "mixed";
      scenariosMissing += 1;
    } else if (!allSameStatus) {
      statusChange = "mixed";
    }

    if (firstValidStatus && lastValidStatus && !statuses.includes("missing")) {
      if (firstValidStatus === "pass" && lastValidStatus !== "pass") {
        statusChange = "regressed";
      } else if (firstValidStatus !== "pass" && lastValidStatus === "pass") {
        statusChange = "improved";
      } else if (firstValidStatus !== lastValidStatus) {
        statusChange = "mixed";
      }
    }

    if (statusChange === "regressed") {
      scenariosRegressed += 1;
      scenariosChanged += 1;
    } else if (statusChange === "improved") {
      scenariosImproved += 1;
      scenariosChanged += 1;
    } else if (statusChange === "mixed") {
      scenariosChanged += 1;
    }

    scenarios.push({
      alignment_key: key,
      file: info.file,
      scenario_id: info.scenarioId,
      scenario_name: info.scenarioName,
      present_in: presentIn,
      entries,
      delta_score: deltaScore,
      status_change: statusChange,
    });
  }

  scenarios.sort((a, b) => {
    if (a.status_change === "regressed" && b.status_change !== "regressed") {
      return -1;
    }
    if (b.status_change === "regressed" && a.status_change !== "regressed") {
      return 1;
    }
    return a.alignment_key.localeCompare(b.alignment_key);
  });

  return {
    alignment,
    runs: runs.map(runSummary),
    scenarios,
    summary: {
      total_scenarios: scenarios.length,
      scenarios_changed: scenariosChanged,
      scenarios_regressed: scenariosRegressed,
      scenarios_improved: scenariosImproved,
      scenarios_missing_in_some: scenariosMissing,
      average_score_delta:
        totalDeltaCount > 0 ? totalDelta / totalDeltaCount : null,
    },
  };
}

export type ComparisonController = {
  compare: (runIds: string[]) => Promise<ComparisonPayload>;
};

export function createComparisonController(options: {
  repository: ReadableRepository;
}): ComparisonController {
  const { repository } = options;
  return {
    async compare(runIds: string[]): Promise<ComparisonPayload> {
      const trimmed = runIds
        .map((id) => (typeof id === "string" ? id.trim() : ""))
        .filter((id) => id.length > 0);
      const seen = new Set<string>();
      for (const id of trimmed) {
        if (!RUN_ID_PATTERN.test(id)) {
          throw new HttpInputError(
            400,
            "bad_request",
            "run_ids must contain persisted run UUIDs.",
          );
        }
        const normalized = id.toLowerCase();
        if (seen.has(normalized)) {
          throw new HttpInputError(
            400,
            "bad_request",
            "run_ids must not contain duplicates.",
          );
        }
        seen.add(normalized);
      }
      if (trimmed.length < MIN_COMPARISON_RUNS) {
        throw new HttpInputError(
          400,
          "bad_request",
          `At least ${MIN_COMPARISON_RUNS} run_ids are required for comparison.`,
        );
      }
      if (trimmed.length > MAX_COMPARISON_RUNS) {
        throw new HttpInputError(
          400,
          "bad_request",
          `At most ${MAX_COMPARISON_RUNS} run_ids may be compared in a single request.`,
        );
      }
      const runs = await Promise.all(
        trimmed.map(async (runId) => {
          const record = await repository.getRun(runId);
          if (!record) {
            throw new HttpInputError(
              404,
              "not_found",
              `Run \`${runId}\` was not found.`,
            );
          }
          return record;
        }),
      );
      return buildComparisonPayload(runs);
    },
  };
}

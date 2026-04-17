import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

type ComparisonScenarioStatus =
  | "pass"
  | "fail"
  | "harness_fail"
  | "error"
  | "missing"
  | "running";

type ComparisonRunSummary = {
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

type ComparisonScenarioEntry = {
  run_id: string;
  status: ComparisonScenarioStatus;
  score: number | null;
  reason: string | null;
};

type ComparisonScenarioRow = {
  alignment_key: string;
  file: string | null;
  scenario_id: string;
  scenario_name: string | null;
  present_in: string[];
  entries: Record<string, ComparisonScenarioEntry>;
  delta_score: number | null;
  status_change: "unchanged" | "regressed" | "improved" | "mixed";
};

type ComparisonPayload = {
  alignment: string;
  runs: ComparisonRunSummary[];
  scenarios: ComparisonScenarioRow[];
  summary: {
    total_scenarios: number;
    scenarios_changed: number;
    scenarios_regressed: number;
    scenarios_improved: number;
    scenarios_missing_in_some: number;
    average_score_delta: number | null;
  };
};

type RunOption = {
  runId: string;
  status: string;
  label: string | null;
  startedAt: string;
};

type RunsResponse = {
  runs: Array<{
    runId: string;
    status: string;
    label?: string | null;
    startedAt: string;
  }>;
};

type ApiError = { error?: { code?: string; message?: string } };

type CompareViewProps = {
  token: string | null;
  apiBase?: string;
};

function buildHeaders(token: string | null): HeadersInit {
  return token ? { authorization: `Bearer ${token}` } : {};
}

function formatScore(value: number | null): string {
  if (value === null) return "—";
  return value.toFixed(2);
}

function formatDelta(value: number | null): string {
  if (value === null) return "—";
  const formatted = value.toFixed(2);
  return value > 0 ? `+${formatted}` : formatted;
}

function formatStatusLabel(status: ComparisonScenarioStatus): string {
  if (status === "pass") return "PASS";
  if (status === "fail") return "FAIL";
  if (status === "harness_fail") return "HARNESS";
  if (status === "error") return "ERROR";
  if (status === "missing") return "—";
  if (status === "running") return "RUN";
  return status;
}

function parseRunIds(search: string): string[] {
  const params = new URLSearchParams(search);
  const raw = params.get("run_ids");
  if (!raw) return [];
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function parseOnlyChanges(search: string): boolean {
  const params = new URLSearchParams(search);
  return params.get("only") === "changes";
}

function updateLocation(runIds: string[], onlyChanges: boolean): void {
  const params = new URLSearchParams();
  if (runIds.length > 0) {
    params.set("run_ids", runIds.join(","));
  }
  if (onlyChanges) {
    params.set("only", "changes");
  }
  const search = params.toString();
  const query = search ? `?${search}` : "";
  const next = `/compare${query}`;
  if (window.location.pathname + window.location.search !== next) {
    window.history.replaceState(null, "", next);
  }
}

export function CompareView({ token, apiBase = "" }: CompareViewProps) {
  const [runIds, setRunIds] = useState<string[]>(() =>
    parseRunIds(window.location.search),
  );
  const [onlyChanges, setOnlyChanges] = useState<boolean>(() =>
    parseOnlyChanges(window.location.search),
  );
  const [payload, setPayload] = useState<ComparisonPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(runIds.length < 2);
  const [availableRuns, setAvailableRuns] = useState<RunOption[]>([]);
  const [picker, setPicker] = useState<Set<string>>(new Set(runIds));
  const pickerCanApply = picker.size >= 2 && picker.size <= 10;

  const fetchRuns = useCallback(async () => {
    try {
      const response = await fetch(`${apiBase}/api/runs?limit=100`, {
        headers: buildHeaders(token),
      });
      if (!response.ok) {
        throw new Error(`/api/runs returned ${response.status}`);
      }
      const body = (await response.json()) as RunsResponse;
      setAvailableRuns(
        body.runs.map((run) => ({
          runId: run.runId,
          status: run.status,
          label: run.label ?? null,
          startedAt: run.startedAt,
        })),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [apiBase, token]);

  useEffect(() => {
    void fetchRuns();
  }, [fetchRuns]);

  useEffect(() => {
    if (runIds.length < 2) {
      setPayload(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    const query = new URLSearchParams({ run_ids: runIds.join(",") });
    fetch(`${apiBase}/api/comparisons?${query.toString()}`, {
      headers: buildHeaders(token),
    })
      .then(async (response) => {
        if (!response.ok) {
          const body = (await response.json()) as ApiError;
          throw new Error(
            body.error?.message ??
              `/api/comparisons returned ${response.status}`,
          );
        }
        return (await response.json()) as ComparisonPayload;
      })
      .then((body) => {
        if (cancelled) return;
        setPayload(body);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setPayload(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [apiBase, runIds, token]);

  useEffect(() => {
    updateLocation(runIds, onlyChanges);
  }, [runIds, onlyChanges]);

  const onTogglePicker = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const runId = event.target.value;
    setPicker((previous) => {
      const next = new Set(previous);
      if (next.has(runId)) {
        next.delete(runId);
      } else {
        next.add(runId);
      }
      return next;
    });
  }, []);

  const onApplyPicker = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const nextIds = Array.from(picker);
      if (nextIds.length < 2) {
        setError("Select at least 2 runs to compare.");
        return;
      }
      if (nextIds.length > 10) {
        setError("Select at most 10 runs to compare.");
        return;
      }
      setError(null);
      setRunIds(nextIds);
      setPickerOpen(false);
    },
    [picker],
  );

  const filteredScenarios = useMemo(() => {
    if (!payload) return [];
    if (!onlyChanges) return payload.scenarios;
    return payload.scenarios.filter((row) => row.status_change !== "unchanged");
  }, [payload, onlyChanges]);

  return (
    <div className="compare-view">
      <header className="compare-header">
        <h1>Compare Runs</h1>
        <div className="compare-actions">
          <button
            type="button"
            onClick={() => {
              setPicker(new Set(runIds));
              setPickerOpen((previous) => !previous);
            }}
          >
            {pickerOpen ? "Hide picker" : "Choose runs"}
          </button>
          <label>
            <input
              type="checkbox"
              checked={onlyChanges}
              onChange={(event) => setOnlyChanges(event.target.checked)}
            />
            Only changes
          </label>
        </div>
      </header>

      {error && <div className="compare-error">{error}</div>}
      {loading && <div className="compare-loading">Loading comparison…</div>}

      {pickerOpen && (
        <form className="compare-picker" onSubmit={onApplyPicker}>
          <p>
            Select 2–10 runs to compare. Currently selected:{" "}
            <strong>{picker.size}</strong>
          </p>
          <ul>
            {availableRuns.map((run) => (
              <li key={run.runId}>
                <label>
                  <input
                    type="checkbox"
                    value={run.runId}
                    checked={picker.has(run.runId)}
                    onChange={onTogglePicker}
                  />
                  <code>{run.runId}</code>
                  <span className="compare-run-label">
                    {run.label ? ` · ${run.label}` : ""} · {run.status} ·{" "}
                    {new Date(run.startedAt).toLocaleString()}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <button type="submit" disabled={!pickerCanApply}>
            Apply
          </button>
        </form>
      )}

      {payload && (
        <>
          <section className="compare-summary" data-sticky="true">
            <div>
              <strong>Alignment:</strong> <code>{payload.alignment}</code>
            </div>
            <div>
              <strong>Total:</strong> {payload.summary.total_scenarios}
            </div>
            <div>
              <strong>Regressed:</strong> {payload.summary.scenarios_regressed}
            </div>
            <div>
              <strong>Improved:</strong> {payload.summary.scenarios_improved}
            </div>
            <div>
              <strong>Mixed/missing:</strong>{" "}
              {payload.summary.scenarios_missing_in_some}
            </div>
            <div>
              <strong>Δ avg score:</strong>{" "}
              {formatDelta(payload.summary.average_score_delta)}
            </div>
          </section>

          <table className="compare-table">
            <thead>
              <tr>
                <th>Scenario</th>
                {payload.runs.map((run) => (
                  <th key={run.run_id}>
                    <div>
                      <code>{run.run_id.slice(0, 10)}</code>
                    </div>
                    <div className="compare-run-meta">
                      {run.label ?? run.status}
                    </div>
                  </th>
                ))}
                <th>Δ score</th>
                <th>Change</th>
              </tr>
            </thead>
            <tbody>
              {filteredScenarios.map((row) => (
                <tr
                  key={row.alignment_key}
                  className={`compare-row compare-row--${row.status_change}`}
                >
                  <td>
                    <div>
                      <strong>{row.scenario_name ?? row.scenario_id}</strong>
                    </div>
                    <div className="compare-scenario-meta">
                      <code>{row.scenario_id}</code>
                      {row.file ? ` · ${row.file}` : ""}
                    </div>
                  </td>
                  {payload.runs.map((run) => {
                    const entry = row.entries[run.run_id];
                    return (
                      <td
                        key={run.run_id}
                        className={`compare-cell compare-cell--${entry?.status ?? "missing"}`}
                        title={entry?.reason ?? undefined}
                      >
                        <div>
                          {formatStatusLabel(entry?.status ?? "missing")}
                        </div>
                        <div className="compare-score">
                          {formatScore(entry?.score ?? null)}
                        </div>
                      </td>
                    );
                  })}
                  <td>{formatDelta(row.delta_score)}</td>
                  <td>{row.status_change}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {filteredScenarios.length === 0 && (
            <p className="compare-hint">
              No aligned scenario rows match this comparison.
            </p>
          )}
        </>
      )}

      {!payload && !loading && runIds.length < 2 && (
        <p className="compare-hint">
          Select at least two runs above to load a comparison.
        </p>
      )}
    </div>
  );
}

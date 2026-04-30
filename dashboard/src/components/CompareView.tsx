import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Badge } from "../components/ui/badge.tsx";
import {
  Button,
  Card,
  Checkbox,
  EmptyState,
  ErrorBanner,
  Loading,
  PageHeader,
  StatTile,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../ui/index.tsx";
import { CategoryRadar } from "./CategoryRadar.tsx";

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
  category?: string | null;
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

function statusVariantFor(status: ComparisonScenarioStatus): {
  variant: "success" | "destructive" | "info" | "warning" | "secondary";
  label: string;
} {
  switch (status) {
    case "pass":
      return { variant: "success", label: "Pass" };
    case "fail":
      return { variant: "destructive", label: "Fail" };
    case "harness_fail":
      return { variant: "warning", label: "Harness" };
    case "error":
      return { variant: "destructive", label: "Error" };
    case "running":
      return { variant: "info", label: "Running" };
    default:
      return { variant: "secondary", label: "—" };
  }
}

function changeBadge(change: ComparisonScenarioRow["status_change"]) {
  if (change === "regressed") {
    return <Badge variant="destructive">Regressed</Badge>;
  }
  if (change === "improved") {
    return <Badge variant="success">Improved</Badge>;
  }
  if (change === "mixed") {
    return <Badge variant="warning">Mixed</Badge>;
  }
  return <Badge variant="secondary">Unchanged</Badge>;
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

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
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
      return undefined;
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

  const visibleAverageDelta = useMemo<number | null>(() => {
    const deltas = filteredScenarios
      .map((row) => row.delta_score)
      .filter((value): value is number => typeof value === "number");
    if (deltas.length === 0) return null;
    const total = deltas.reduce((sum, value) => sum + value, 0);
    return total / deltas.length;
  }, [filteredScenarios]);

  return (
    <>
      <PageHeader
        eyebrow="Comparison"
        title="Compare runs"
        meta={
          payload
            ? `Aligned by ${payload.alignment.replace("_", " ")} · ${payload.summary.total_scenarios} scenarios`
            : "Pick 2–10 runs to align scenarios side by side"
        }
        actions={
          <>
            <Checkbox
              checked={onlyChanges}
              onChange={setOnlyChanges}
              label="Only changes"
            />
            <Button
              variant="secondary"
              disabled={runIds.length < 2}
              onClick={() => {
                setRunIds((previous) => [...previous].reverse());
              }}
              title="Swap which run is treated as the baseline"
            >
              Reverse order
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setPicker(new Set(runIds));
                setPickerOpen((previous) => !previous);
              }}
            >
              {pickerOpen ? "Hide picker" : "Choose runs"}
            </Button>
          </>
        }
      />

      {error ? <ErrorBanner message={error} /> : null}

      {pickerOpen ? (
        <Card className="p-4 mb-6">
          <form onSubmit={onApplyPicker} className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <div className="text-sm">
                <span className="text-muted-foreground">
                  Select 2–10 runs to compare ·
                </span>{" "}
                <span className="font-medium">{picker.size} selected</span>
              </div>
              <Button type="submit" disabled={!pickerCanApply}>
                Apply selection
              </Button>
            </div>
            <div className="max-h-[320px] overflow-y-auto rounded-md border border-border divide-y divide-border bg-card">
              {availableRuns.length === 0 ? (
                <div className="p-6 text-center text-sm text-muted-foreground">
                  No runs available.
                </div>
              ) : (
                availableRuns.map((run) => {
                  const checked = picker.has(run.runId);
                  return (
                    <label
                      key={run.runId}
                      className={`flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-secondary/50 ${
                        checked ? "bg-primary/5" : ""
                      }`}
                    >
                      <input
                        type="checkbox"
                        value={run.runId}
                        checked={checked}
                        onChange={onTogglePicker}
                        className="size-4 accent-primary"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-2">
                          {run.label ? (
                            <span className="font-medium text-foreground truncate">
                              {run.label}
                            </span>
                          ) : (
                            <span className="font-mono text-xs text-muted-foreground truncate">
                              {run.runId.slice(0, 12)}…
                            </span>
                          )}
                          <span className="text-xs text-muted-foreground/70">
                            · {run.status}
                          </span>
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {fmtDate(run.startedAt)}
                        </div>
                      </div>
                    </label>
                  );
                })
              )}
            </div>
          </form>
        </Card>
      ) : null}

      {loading ? <Loading label="Loading comparison…" /> : null}

      {payload ? (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-6">
            <StatTile label="Total" value={payload.summary.total_scenarios} />
            <StatTile
              label="Regressed"
              tone="danger"
              value={payload.summary.scenarios_regressed}
            />
            <StatTile
              label="Improved"
              tone="success"
              value={payload.summary.scenarios_improved}
            />
            <StatTile
              label="Mixed / missing"
              value={payload.summary.scenarios_missing_in_some}
            />
            <StatTile
              label={onlyChanges ? "Δ avg score (changes)" : "Δ avg score"}
              tone={
                visibleAverageDelta != null && visibleAverageDelta < 0
                  ? "danger"
                  : visibleAverageDelta != null && visibleAverageDelta > 0
                    ? "success"
                    : "default"
              }
              value={formatDelta(visibleAverageDelta)}
            />
          </div>

          <Card className="p-4 mb-6">
            <div className="text-sm font-medium text-foreground mb-1">
              Category fingerprint
            </div>
            <div className="text-xs text-muted-foreground mb-3">
              Mean score per task category, one polygon per run.
            </div>
            <CategoryRadar
              runs={payload.runs.map((run) => ({
                run_id: run.run_id,
                label: run.label,
              }))}
              scenarios={payload.scenarios}
            />
          </Card>

          <Card className="overflow-hidden">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="min-w-[200px]">Scenario</TableHead>
                    {payload.runs.map((run, idx) => {
                      const role =
                        idx === 0
                          ? "baseline"
                          : idx === payload.runs.length - 1
                            ? "target"
                            : null;
                      return (
                        <TableHead key={run.run_id} className="min-w-[140px]">
                          {role ? (
                            <div className="text-[10px] uppercase tracking-wider text-muted-foreground/70 font-semibold mb-0.5">
                              {role}
                            </div>
                          ) : null}
                          <div className="font-mono text-[11px] text-foreground">
                            {run.run_id.slice(0, 10)}
                          </div>
                          <div className="text-[10px] normal-case text-muted-foreground/80 font-normal mt-0.5">
                            {run.label ?? run.status}
                          </div>
                        </TableHead>
                      );
                    })}
                    <TableHead className="text-right">Δ score</TableHead>
                    <TableHead>Change</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredScenarios.map((row) => (
                    <TableRow key={row.alignment_key}>
                      <TableCell>
                        <div className="font-medium text-foreground">
                          {row.scenario_name ?? row.scenario_id}
                        </div>
                        <div className="text-xs text-muted-foreground font-mono">
                          {row.scenario_id}
                          {row.file ? ` · ${row.file}` : ""}
                        </div>
                      </TableCell>
                      {payload.runs.map((run) => {
                        const entry = row.entries[run.run_id];
                        const cfg = statusVariantFor(
                          entry?.status ?? "missing",
                        );
                        return (
                          <TableCell
                            key={run.run_id}
                            title={entry?.reason ?? undefined}
                          >
                            <div className="flex flex-col items-start gap-1">
                              <Badge
                                variant={cfg.variant}
                                className="text-[10px] uppercase tracking-wider"
                              >
                                {cfg.label}
                              </Badge>
                              <span className="font-mono text-xs text-muted-foreground">
                                {formatScore(entry?.score ?? null)}
                              </span>
                            </div>
                          </TableCell>
                        );
                      })}
                      <TableCell className="text-right font-mono">
                        {formatDelta(row.delta_score)}
                      </TableCell>
                      <TableCell>{changeBadge(row.status_change)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {filteredScenarios.length === 0 ? (
              <div className="p-6 text-center text-sm text-muted-foreground">
                No aligned scenario rows match this comparison.
              </div>
            ) : null}
          </Card>
        </>
      ) : null}

      {!payload && !loading && runIds.length < 2 ? (
        <EmptyState
          title="Select at least two runs"
          description="Open the Choose runs picker above and select 2–10 runs from the same preset (or compatible scenario sets) to align them side by side."
        />
      ) : null}
    </>
  );
}

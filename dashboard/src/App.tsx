import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { jsonBody, useServerRequest } from "./api/client.ts";
import { DashboardQueryProvider } from "./api/query-client.tsx";
import type {
  HealthResponse,
  OpenRouterStatusResponse,
  Preset,
  PresetResponse,
  PresetRunsResponse,
  PresetsResponse,
  ReadyResponse,
  RunRecord,
  RunResponse,
  RunSummary,
  RunsResponse,
  ScenarioResponse,
  ScenariosResponse,
  SecretStatus,
  ServerRequest,
  ServerScenario,
  SuitesResponse,
} from "./api/types.ts";
import { AveragesTable } from "./components/AveragesTable.tsx";
import { CompareView } from "./components/CompareView.tsx";
import { ConversationView } from "./components/ConversationView.tsx";
import { DetailPanel } from "./components/DetailPanel.tsx";
import { ProgressBar } from "./components/ProgressBar.tsx";
import { RubricView } from "./components/RubricView.tsx";
import { ScenarioTable } from "./components/ScenarioTable.tsx";
import { StatsBar } from "./components/StatsBar.tsx";
import { ThemeToggle } from "./components/theme-toggle.tsx";
import { useDashboard } from "./hooks/useDashboard.ts";
import type {
  DashboardData,
  DimensionScore,
  ScenarioDetail,
  ScenarioState,
} from "./types.ts";
import {
  Button,
  Card,
  CardSkeleton,
  Checkbox,
  EmptyState,
  ErrorBanner,
  Field,
  Loading,
  Modal,
  PageHeader,
  PageHeaderSkeleton,
  RunsTableSkeleton,
  SimpleSelect,
  StatTile,
  StatTilesSkeleton,
  StatusPill,
  Tag,
  TextInput,
} from "./ui/index.tsx";
import { EndpointsView } from "./views/EndpointsView.tsx";
import { PresetEditorView } from "./views/PresetEditorView.tsx";
import { PresetRunHistory } from "./views/PresetRunHistory.tsx";
import {
  RunLaunchModal,
  type RunLaunchOptions,
} from "./views/RunLaunchModal.tsx";
import { RunMetaEditor } from "./views/RunMetaEditor.tsx";
import {
  ScenarioDetailsModal,
  type ScenarioDetailsTarget,
} from "./views/ScenarioDetailsModal.tsx";
import { ScoreIndexView, ScoreSessionView } from "./views/ScoreView.tsx";

type AppMode = "detecting" | "live" | "server";

function timestampSeconds(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const millis = Date.parse(value);
  return Number.isNaN(millis) ? null : millis / 1000;
}

function elapsedSeconds(
  startedAt: string,
  completedAt?: string | null,
): number {
  const start = timestampSeconds(startedAt);
  if (start == null) {
    return 0;
  }
  const end = timestampSeconds(completedAt) ?? Date.now() / 1000;
  return Math.max(0, end - start);
}

function scenarioStatus(scenario: ServerScenario): ScenarioState["status"] {
  if (scenario.status === "running") {
    return "running";
  }
  if (scenario.status === "pending") {
    return "pending";
  }
  if (scenario.status === "error" || scenario.status === "runtime_error") {
    return "error";
  }
  if (scenario.passed === true) {
    return "pass";
  }
  if (scenario.passed === false) {
    return "fail";
  }
  return "pending";
}

function stringifyError(error: unknown): string | null {
  if (!error) {
    return null;
  }
  if (typeof error === "string") {
    return error;
  }
  if (typeof error === "object") {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string") {
      return message;
    }
    return JSON.stringify(error);
  }
  return String(error);
}

function normalizeDimension(raw: Record<string, unknown>): DimensionScore {
  return {
    dimension_id: String(raw.dimension_id ?? ""),
    dimension_name: String(raw.dimension_name ?? raw.dimension_id ?? ""),
    raw_score:
      typeof raw.raw_score === "number" ? raw.raw_score : Number(raw.raw_score),
    scale_points:
      raw.scale_points == null ? null : Number(raw.scale_points as number),
    normalized_score:
      raw.normalized_score == null
        ? null
        : Number(raw.normalized_score as number),
    weight: raw.weight == null ? null : Number(raw.weight as number),
    reasoning: typeof raw.reasoning === "string" ? raw.reasoning : "",
    evidence: Array.isArray(raw.evidence) ? raw.evidence.map(String) : [],
  };
}

function scenarioDetail(scenario: ServerScenario): ScenarioDetail {
  return {
    scenario_id: scenario.scenarioId,
    scenario_name: scenario.scenarioName,
    user_id: scenario.userId ?? undefined,
    passed: scenario.passed === true,
    overall_score: scenario.overallScore ?? null,
    pass_threshold: scenario.passThreshold ?? null,
    status: scenario.status,
    judge: scenario.judge
      ? {
          provider: scenario.judge.provider ?? undefined,
          model: scenario.judge.model ?? undefined,
          temperature: scenario.judge.temperature ?? undefined,
          max_tokens: scenario.judge.maxTokens ?? undefined,
          overall_notes: scenario.judge.overallNotes ?? undefined,
          output:
            scenario.judge.output &&
            typeof scenario.judge.output === "object" &&
            !Array.isArray(scenario.judge.output)
              ? (scenario.judge.output as Record<string, unknown>)
              : undefined,
        }
      : undefined,
    turns: (scenario.turns ?? []) as unknown as ScenarioDetail["turns"],
    tool_calls: (scenario.toolCalls ??
      []) as unknown as ScenarioDetail["tool_calls"],
    target_events: scenario.targetEvents ?? [],
    checkpoints: (scenario.checkpoints ??
      []) as unknown as ScenarioDetail["checkpoints"],
    judge_dimension_scores: (scenario.judgeDimensionScores ?? []).map(
      normalizeDimension,
    ),
    expectations: scenario.expectations,
    error: scenario.error,
    counts: scenario.counts
      ? {
          turn_count: scenario.counts.turnCount,
          assistant_turn_count: scenario.counts.assistantTurnCount,
          tool_call_count: scenario.counts.toolCallCount,
          checkpoint_count: scenario.counts.checkpointCount,
        }
      : undefined,
  };
}

function dashboardDataFromRun(run: RunRecord): DashboardData {
  const scenarios = run.scenarios.map(
    (scenario): ScenarioState => ({
      scenario_id: scenario.scenarioId,
      scenario_name: scenario.scenarioName,
      status: scenarioStatus(scenario),
      score: scenario.overallScore ?? null,
      error: stringifyError(scenario.error),
      started_at: timestampSeconds(scenario.startedAt),
      finished_at: timestampSeconds(scenario.completedAt),
    }),
  );
  const details: Record<number, ScenarioDetail> = {};
  for (const scenario of run.scenarios) {
    details[scenario.ordinal] = scenarioDetail(scenario);
  }
  const running = scenarios.filter(
    (scenario) => scenario.status === "running",
  ).length;
  const done = scenarios.filter(
    (scenario) =>
      scenario.status !== "running" && scenario.status !== "pending",
  ).length;
  return {
    total: run.aggregateCounts.scenarioTotal || scenarios.length,
    elapsed: elapsedSeconds(run.startedAt, run.completedAt),
    passed: run.aggregateCounts.scenarioPassedCount,
    failed: run.aggregateCounts.scenarioFailedCount,
    errored: run.aggregateCounts.scenarioErroredCount,
    running,
    done,
    all_done: Boolean(run.completedAt) || running === 0,
    scenarios,
    details,
    averages: [],
  };
}

function usePathname() {
  const [pathname, setPathname] = useState(window.location.pathname);

  useEffect(() => {
    const onPopState = () => setPathname(window.location.pathname);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = useCallback((href: string) => {
    window.history.pushState({}, "", href);
    setPathname(window.location.pathname);
  }, []);

  return { pathname, navigate };
}

function useLocalLinkInterception(navigate: (href: string) => void): void {
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented) {
        return;
      }
      if (!(event.target instanceof Element)) {
        return;
      }
      const anchor = event.target.closest("a");
      if (!anchor) {
        return;
      }
      const href = anchor.getAttribute("href");
      if (
        !href?.startsWith("/") ||
        href.startsWith("//") ||
        href.startsWith("/api/") ||
        anchor.target
      ) {
        return;
      }
      event.preventDefault();
      navigate(href);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [navigate]);
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

const MAX_COMPARE_RUNS = 10;

function RunsTable({
  runs,
  navigate,
  selectable = true,
}: {
  runs: RunSummary[];
  navigate?: (href: string) => void;
  selectable?: boolean;
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    setSelected((prev) => {
      const visible = new Set(runs.map((run) => run.runId));
      const next = new Set<string>();
      prev.forEach((id) => {
        if (visible.has(id)) next.add(id);
      });
      return next.size === prev.size ? prev : next;
    });
  }, [runs]);

  if (runs.length === 0) {
    return (
      <EmptyState
        title="No runs recorded"
        description="Launch a preset or start an ad-hoc run to populate this table."
      />
    );
  }

  const toggle = (runId: string, next: boolean) => {
    setSelected((prev) => {
      const updated = new Set(prev);
      if (next) {
        if (updated.size >= MAX_COMPARE_RUNS && !updated.has(runId)) {
          return prev;
        }
        updated.add(runId);
      } else {
        updated.delete(runId);
      }
      return updated;
    });
  };

  const selectedIds = runs
    .map((run) => run.runId)
    .filter((id) => selected.has(id));
  const compareDisabled =
    selectedIds.length < 2 || selectedIds.length > MAX_COMPARE_RUNS;
  const compareHint =
    selectedIds.length === 0
      ? "Pick 2+ runs to compare"
      : selectedIds.length === 1
        ? "Pick at least one more run"
        : selectedIds.length > MAX_COMPARE_RUNS
          ? `Maximum ${MAX_COMPARE_RUNS} runs at a time`
          : `${selectedIds.length} runs selected`;

  const compareHref = `/compare?run_ids=${selectedIds.join(",")}`;

  const onCompare = () => {
    if (compareDisabled) return;
    if (navigate) {
      navigate(compareHref);
    } else {
      window.history.pushState({}, "", compareHref);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
  };

  return (
    <>
      {selectable ? (
        <div className="flex items-center gap-3 mb-3">
          <Button
            variant="primary"
            size="sm"
            onClick={onCompare}
            disabled={compareDisabled}
          >
            Compare selected
          </Button>
          <span className="text-xs text-muted-foreground">{compareHint}</span>
          {selectedIds.length > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelected(new Set())}
            >
              Clear
            </Button>
          ) : null}
        </div>
      ) : null}
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-secondary">
              <tr className="text-left text-muted-foreground text-xs uppercase tracking-wider">
                {selectable ? <th className="px-3 py-2 w-8" /> : null}
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Preset</th>
                <th className="px-3 py-2">Started</th>
                <th className="px-3 py-2 text-right">Pass / Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {runs.map((run) => {
                const isSelected = selected.has(run.runId);
                const atCap =
                  !isSelected && selectedIds.length >= MAX_COMPARE_RUNS;
                return (
                  <tr key={run.runId} className="hover:bg-secondary">
                    {selectable ? (
                      <td className="px-3 py-2 align-middle">
                        <Checkbox
                          checked={isSelected}
                          onChange={(next) => {
                            if (atCap && next) return;
                            toggle(run.runId, next);
                          }}
                        />
                      </td>
                    ) : null}
                    <td className="px-3 py-2">
                      <a
                        href={`/runs/${encodeURIComponent(run.runId)}`}
                        className="text-foreground hover:text-primary"
                      >
                        {run.label ? (
                          <span className="font-medium">{run.label}</span>
                        ) : (
                          <span className="font-mono text-xs text-muted-foreground">
                            {run.runId.slice(0, 12)}…
                          </span>
                        )}
                      </a>
                    </td>
                    <td className="px-3 py-2">
                      <StatusPill run={run} />
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {run.preset ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {fmtDate(run.startedAt)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono">
                      {run.aggregateCounts.scenarioPassedCount}/
                      {run.aggregateCounts.scenarioTotal}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

function OverviewView({
  request,
  navigate,
}: {
  request: ServerRequest;
  navigate: (href: string) => void;
}) {
  const [runs, setRuns] = useState<RunsResponse | null>(null);
  const [suites, setSuites] = useState<SuitesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      request<RunsResponse>("/api/runs?limit=5"),
      request<SuitesResponse>("/api/suites"),
    ])
      .then(([nextRuns, nextSuites]) => {
        if (cancelled) return;
        setRuns(nextRuns);
        setSuites(nextSuites);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [request]);

  if (error) return <ErrorBanner message={error} />;
  if (!runs || !suites) {
    return (
      <>
        <PageHeaderSkeleton />
        <StatTilesSkeleton />
        <div className="text-xs uppercase tracking-wider text-muted-foreground font-semibold mb-2">
          Latest Runs
        </div>
        <RunsTableSkeleton rows={5} />
      </>
    );
  }

  const passed = runs.runs.filter((run) => run.passed === true).length;
  const failed = runs.runs.filter((run) => run.passed === false).length;

  return (
    <>
      <PageHeader eyebrow="Overview" title="AgentProbe" />
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <StatTile label="Total Runs" value={runs.total} />
        <StatTile label="Recent Passed" tone="success" value={passed} />
        <StatTile label="Recent Failed" tone="danger" value={failed} />
        <StatTile label="Suites" tone="accent" value={suites.suites.length} />
      </div>
      <div className="text-xs uppercase tracking-wider text-muted-foreground font-semibold mb-2">
        Latest Runs
      </div>
      <RunsTable runs={runs.runs} navigate={navigate} />
    </>
  );
}

const RUNS_PAGE_SIZE = 50;

function RunsView({
  request,
  navigate,
}: {
  request: ServerRequest;
  navigate: (href: string) => void;
}) {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    request<RunsResponse>(`/api/runs?limit=${RUNS_PAGE_SIZE}&offset=0`)
      .then((next) => {
        if (cancelled) return;
        setRuns(next.runs);
        setTotal(next.total);
        setNextCursor(next.next_cursor ?? null);
        setInitialized(true);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [request]);

  const loadMore = useCallback(() => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    request<RunsResponse>(
      `/api/runs?limit=${RUNS_PAGE_SIZE}&offset=${encodeURIComponent(nextCursor)}`,
    )
      .then((next) => {
        setRuns((prev) => [...prev, ...next.runs]);
        setTotal(next.total);
        setNextCursor(next.next_cursor ?? null);
        setError(null);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        setLoadingMore(false);
      });
  }, [nextCursor, loadingMore, request]);

  if (error && !initialized) return <ErrorBanner message={error} />;
  if (!initialized) {
    return (
      <>
        <PageHeaderSkeleton withMeta />
        <RunsTableSkeleton rows={8} />
      </>
    );
  }

  return (
    <>
      <PageHeader eyebrow="History" title="Runs" meta={`${total} total`} />
      {error ? <ErrorBanner message={error} /> : null}
      <RunsTable runs={runs} navigate={navigate} />
      {nextCursor ? (
        <div className="mt-4 flex justify-center">
          <Button variant="secondary" onClick={loadMore} disabled={loadingMore}>
            {loadingMore
              ? "Loading..."
              : `Load more (${runs.length} of ${total})`}
          </Button>
        </div>
      ) : null}
    </>
  );
}

export function RunDetailView({
  runId,
  request,
  navigate,
}: {
  runId: string;
  request: ServerRequest;
  navigate?: (href: string) => void;
}) {
  const [run, setRun] = useState<RunRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [presetModalOpen, setPresetModalOpen] = useState(false);
  const [presetName, setPresetName] = useState("");
  const [presetDescription, setPresetDescription] = useState("");
  const [savingPreset, setSavingPreset] = useState(false);
  const [presetError, setPresetError] = useState<string | null>(null);
  const requestRef = useRef(request);
  const activeRunIdRef = useRef(runId);
  const mountedRef = useRef(true);

  requestRef.current = request;
  activeRunIdRef.current = runId;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadRun = useCallback(async () => {
    const expectedRunId = runId;
    try {
      const data = await requestRef.current<RunResponse>(
        `/api/runs/${encodeURIComponent(expectedRunId)}`,
      );
      if (!mountedRef.current || activeRunIdRef.current !== expectedRunId) {
        return;
      }
      setRun(data.run);
      setError(null);
    } catch (err) {
      if (!mountedRef.current || activeRunIdRef.current !== expectedRunId) {
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [runId]);

  const loadRunRef = useRef(loadRun);
  loadRunRef.current = loadRun;

  useEffect(() => {
    setRun(null);
    setError(null);
    void loadRun();
  }, [loadRun]);

  useEffect(() => {
    const events = new EventSource(
      `/api/runs/${encodeURIComponent(runId)}/events`,
    );
    const refetch = () => {
      void loadRunRef.current();
    };
    const refetchAndClose = () => {
      refetch();
      events.close();
    };
    events.addEventListener("snapshot", refetch);
    events.addEventListener("suite_started", refetch);
    events.addEventListener("scenario_started", refetch);
    events.addEventListener("scenario_finished", refetch);
    events.addEventListener("scenario_error", refetch);
    events.addEventListener("run_finished", refetchAndClose);
    events.addEventListener("run_cancelled", refetchAndClose);
    events.addEventListener("run_error", refetchAndClose);
    return () => events.close();
  }, [runId]);

  const cancelRun = async () => {
    setCancelling(true);
    setError(null);
    try {
      await request(`/api/runs/${encodeURIComponent(runId)}/cancel`, {
        method: "POST",
      });
      await loadRun();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCancelling(false);
    }
  };

  const dashboardData = useMemo(
    () => (run ? dashboardDataFromRun(run) : null),
    [run],
  );

  const goToScenario = useCallback(
    (ordinal: number) => {
      if (!navigate || !run) return;
      navigate(`/runs/${encodeURIComponent(run.runId)}/scenarios/${ordinal}`);
    },
    [navigate, run],
  );

  const openPresetModal = () => {
    setPresetError(null);
    const fallback =
      run?.label ?? run?.preset ?? `Run ${run?.runId.slice(0, 8) ?? ""}`.trim();
    setPresetName(fallback);
    setPresetDescription("");
    setPresetModalOpen(true);
  };

  const submitPreset = async () => {
    if (!run) return;
    const trimmedName = presetName.trim();
    if (trimmedName.length === 0) {
      setPresetError("Name is required.");
      return;
    }
    setSavingPreset(true);
    setPresetError(null);
    try {
      const response = await request<{ preset: { id: string } }>(
        `/api/runs/${encodeURIComponent(run.runId)}/save-as-preset`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: trimmedName,
            description: presetDescription.trim() || null,
          }),
        },
      );
      setPresetModalOpen(false);
      if (navigate && response?.preset?.id) {
        navigate(`/presets/${encodeURIComponent(response.preset.id)}`);
      }
    } catch (err) {
      setPresetError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingPreset(false);
    }
  };

  if (error) return <ErrorBanner message={error} />;
  if (!run || !dashboardData) {
    return (
      <>
        <PageHeaderSkeleton withMeta />
        <StatTilesSkeleton />
        <CardSkeleton lines={4} className="mb-4" />
        <RunsTableSkeleton rows={6} selectable={false} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        eyebrow={
          run.presetId ? (
            <span>
              Run from preset{" "}
              <a
                href={`/presets/${encodeURIComponent(run.presetId)}`}
                className="text-primary hover:underline"
              >
                {run.preset ?? run.presetId}
              </a>
            </span>
          ) : (
            "Run"
          )
        }
        title={
          <span className="font-mono text-base text-muted-foreground break-all">
            {run.runId}
          </span>
        }
        meta={
          <span>
            Started {fmtDate(run.startedAt)} · trigger {run.trigger ?? "—"}
          </span>
        }
        actions={
          <>
            {run.status === "running" && (
              <Button
                variant="secondary"
                onClick={() => void cancelRun()}
                disabled={cancelling}
              >
                {cancelling ? "Cancelling…" : "Cancel"}
              </Button>
            )}
            <Button
              variant="secondary"
              onClick={openPresetModal}
              disabled={!run.scenarios || run.scenarios.length === 0}
              title="Create a preset that reuses this run's endpoint, personas, rubric, and scenarios"
            >
              Save as preset
            </Button>
            <a
              href={`/api/runs/${encodeURIComponent(run.runId)}/report.html`}
              className="inline-flex items-center justify-center gap-1.5 rounded-md font-medium border transition-colors px-3 py-1.5 text-sm bg-secondary text-foreground border-border hover:bg-primary hover:border-border no-underline"
            >
              HTML report
            </a>
          </>
        }
      />
      <Modal
        open={presetModalOpen}
        onClose={() => {
          if (!savingPreset) setPresetModalOpen(false);
        }}
        title="Save as preset"
        description="Captures this run's endpoint, personas, rubric, and the exact scenario selection so you can re-run it later."
        size="md"
        footer={
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="ghost"
              onClick={() => setPresetModalOpen(false)}
              disabled={savingPreset}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => void submitPreset()}
              disabled={savingPreset || presetName.trim().length === 0}
            >
              {savingPreset ? "Saving…" : "Save preset"}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-4 py-2">
          {presetError ? <ErrorBanner message={presetError} /> : null}
          <Field label="Name" htmlFor="preset-from-run-name">
            <TextInput
              id="preset-from-run-name"
              value={presetName}
              onChange={(event) => setPresetName(event.target.value)}
              placeholder="e.g. Nightly smoke (gpt-4o)"
              autoFocus
            />
          </Field>
          <Field label="Description" htmlFor="preset-from-run-description">
            <TextInput
              id="preset-from-run-description"
              value={presetDescription}
              onChange={(event) => setPresetDescription(event.target.value)}
              placeholder="Optional"
            />
          </Field>
        </div>
      </Modal>
      <RunMetaEditor
        run={run}
        request={request}
        onUpdated={(next) =>
          setRun((prev) => (prev ? { ...prev, ...next } : prev))
        }
      />
      <StatsBar data={dashboardData} />
      <ProgressBar data={dashboardData} />
      <ScenarioTable
        data={dashboardData}
        runId={run.runId}
        onSelect={goToScenario}
      />
      <AveragesTable
        averages={dashboardData.averages}
        onSelectRun={goToScenario}
      />
    </>
  );
}

function ScenarioDetailView({
  runId,
  ordinal,
  request,
}: {
  runId: string;
  ordinal: string;
  request: ServerRequest;
}) {
  const [data, setData] = useState<ScenarioResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    request<ScenarioResponse>(
      `/api/runs/${encodeURIComponent(runId)}/scenarios/${encodeURIComponent(
        ordinal,
      )}`,
    )
      .then((next) => {
        if (cancelled) return;
        setData(next);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [request, runId, ordinal]);

  if (error) return <ErrorBanner message={error} />;
  if (!data) {
    return (
      <>
        <PageHeaderSkeleton withMeta />
        <CardSkeleton lines={4} className="mb-3" />
        <CardSkeleton lines={6} />
      </>
    );
  }

  const detail = scenarioDetail(data.scenario);

  return (
    <>
      <PageHeader
        eyebrow={
          <a
            href={`/runs/${encodeURIComponent(data.run.runId)}`}
            className="text-primary hover:underline"
          >
            ← Back to run{" "}
            <span className="font-mono">{data.run.runId.slice(0, 12)}…</span>
          </a>
        }
        title={detail.scenario_name}
        meta={
          <span>
            Scenario #{ordinal} · {detail.scenario_id}
          </span>
        }
        actions={
          <StatusPill
            run={{
              ...data.run,
              exitCode: null,
              preset: null,
              aggregateCounts: {
                scenarioTotal: 1,
                scenarioPassedCount: detail.passed ? 1 : 0,
                scenarioFailedCount: detail.passed ? 0 : 1,
                scenarioErroredCount: detail.status === "error" ? 1 : 0,
              },
            }}
          />
        }
      />
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.65fr)] gap-4">
        <Card className="p-4">
          <div className="text-xs uppercase tracking-wider text-muted-foreground font-semibold mb-3">
            Conversation
          </div>
          <ConversationView detail={detail} />
        </Card>
        <Card className="p-4">
          <div className="text-xs uppercase tracking-wider text-muted-foreground font-semibold mb-3">
            Rubric
          </div>
          <RubricView detail={detail} />
        </Card>
      </div>
    </>
  );
}

function SuitesView({ request }: { request: ServerRequest }) {
  const [suites, setSuites] = useState<SuitesResponse | null>(null);
  const [scenarios, setScenarios] = useState<ScenariosResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      request<SuitesResponse>("/api/suites"),
      request<ScenariosResponse>("/api/scenarios"),
    ])
      .then(([nextSuites, nextScenarios]) => {
        if (cancelled) return;
        setSuites(nextSuites);
        setScenarios(nextScenarios);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [request]);

  if (error) return <ErrorBanner message={error} />;
  if (!suites || !scenarios) {
    return (
      <>
        <PageHeaderSkeleton withMeta />
        <CardSkeleton lines={5} className="mb-3" />
        <CardSkeleton lines={5} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        eyebrow="Data root"
        title={
          <span className="font-mono text-base text-foreground break-all">
            {suites.data_path}
          </span>
        }
        meta={`${suites.suites.length} suite${suites.suites.length === 1 ? "" : "s"} · ${scenarios.scenarios.length} scenario${scenarios.scenarios.length === 1 ? "" : "s"}`}
      />
      {suites.errors.length > 0 && (
        <ErrorBanner
          message={`${suites.errors.length} suite files had validation errors.`}
        />
      )}
      <div className="text-xs uppercase tracking-wider text-muted-foreground font-semibold mb-2">
        Suites
      </div>
      <Card className="overflow-hidden mb-6">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-secondary">
              <tr className="text-left text-muted-foreground text-xs uppercase tracking-wider">
                <th className="px-3 py-2">Suite</th>
                <th className="px-3 py-2">Schema</th>
                <th className="px-3 py-2">Path</th>
                <th className="px-3 py-2 text-right">Objects</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {suites.suites.map((suite) => (
                <tr key={suite.id} className="hover:bg-secondary">
                  <td className="px-3 py-2 font-mono text-xs">{suite.id}</td>
                  <td className="px-3 py-2">
                    <Tag tone="info">{suite.schema}</Tag>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-muted-foreground break-all">
                    {suite.relativePath}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">
                    {suite.objectCount}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <div className="text-xs uppercase tracking-wider text-muted-foreground font-semibold mb-2">
        Scenarios
      </div>
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-secondary">
              <tr className="text-left text-muted-foreground text-xs uppercase tracking-wider">
                <th className="px-3 py-2">Scenario</th>
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Suite</th>
                <th className="px-3 py-2">Tags</th>
                <th className="px-3 py-2">Rubric</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {scenarios.scenarios.map((scenario) => (
                <tr
                  key={`${scenario.suiteId}:${scenario.id}`}
                  className="hover:bg-secondary"
                >
                  <td className="px-3 py-2 font-mono text-xs">{scenario.id}</td>
                  <td className="px-3 py-2">{scenario.name}</td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {scenario.suiteId}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      {scenario.tags.map((tag) => (
                        <Tag key={tag}>{tag}</Tag>
                      ))}
                      {scenario.tags.length === 0 ? (
                        <span className="text-muted-foreground/70">—</span>
                      ) : null}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {scenario.rubric ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

export function StartRunView({
  request,
  navigate,
}: {
  request: ServerRequest;
  navigate: (href: string) => void;
}) {
  const [suites, setSuites] = useState<SuitesResponse | null>(null);
  const [scenarios, setScenarios] = useState<ScenariosResponse | null>(null);
  const [presets, setPresets] = useState<PresetsResponse | null>(null);
  const [endpoint, setEndpoint] = useState("");
  const [personas, setPersonas] = useState("");
  const [rubric, setRubric] = useState("");
  const [presetId, setPresetId] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [label, setLabel] = useState("");
  const [parallelEnabled, setParallelEnabled] = useState(false);
  const [parallelLimit, setParallelLimit] = useState(2);
  const [repeat, setRepeat] = useState(1);
  const [dryRun, setDryRun] = useState(true);
  const [saveAsPreset, setSaveAsPreset] = useState(false);
  const [presetName, setPresetName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [detailsTarget, setDetailsTarget] =
    useState<ScenarioDetailsTarget | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      request<SuitesResponse>("/api/suites"),
      request<ScenariosResponse>("/api/scenarios"),
      request<PresetsResponse>("/api/presets"),
    ])
      .then(([nextSuites, nextScenarios, nextPresets]) => {
        if (cancelled) return;
        setSuites(nextSuites);
        setScenarios(nextScenarios);
        setPresets(nextPresets);
        setEndpoint(
          nextSuites.suites.find((suite) => suite.schema === "endpoints")
            ?.relativePath ?? "",
        );
        setPersonas(
          nextSuites.suites.find((suite) => suite.schema === "personas")
            ?.relativePath ?? "",
        );
        setRubric(
          nextSuites.suites.find((suite) => suite.schema === "rubrics")
            ?.relativePath ?? "",
        );
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [request]);

  const scenarioSelection = useMemo(() => {
    if (!scenarios) return [];
    return scenarios.scenarios
      .filter((scenario) =>
        selected.has(`${scenario.sourcePath}::${scenario.id}`),
      )
      .map((scenario) => ({ file: scenario.sourcePath, id: scenario.id }));
  }, [scenarios, selected]);

  if (error) return <ErrorBanner message={error} />;
  if (!suites || !scenarios || !presets) {
    return (
      <>
        <PageHeaderSkeleton withMeta />
        <CardSkeleton lines={6} className="mb-3" />
        <CardSkeleton lines={4} />
      </>
    );
  }

  const endpointSuites = suites.suites.filter(
    (suite) => suite.schema === "endpoints",
  );
  const personaSuites = suites.suites.filter(
    (suite) => suite.schema === "personas",
  );
  const rubricSuites = suites.suites.filter(
    (suite) => suite.schema === "rubrics",
  );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const parallel = {
        enabled: parallelEnabled,
        limit: parallelEnabled ? parallelLimit : undefined,
      };
      const response = presetId
        ? await request<{ run_id: string }>(
            `/api/presets/${encodeURIComponent(presetId)}/runs`,
            jsonBody("POST", {
              label: label || undefined,
              overrides: {
                parallel,
                repeat,
                dry_run: dryRun,
              },
            }),
          )
        : await request<{ run_id: string }>(
            "/api/runs",
            jsonBody("POST", {
              endpoint,
              personas,
              rubric,
              selection: scenarioSelection,
              parallel,
              repeat,
              dry_run: dryRun,
              label: label || undefined,
              save_as_preset:
                saveAsPreset && presetName.trim()
                  ? { name: presetName.trim() }
                  : undefined,
            }),
          );
      navigate(`/runs/${encodeURIComponent(response.run_id)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <PageHeader
        eyebrow="Start"
        title="Run builder"
        meta={
          presetId
            ? "Launching from preset — overrides only"
            : `${selected.size} scenario${selected.size === 1 ? "" : "s"} selected`
        }
        actions={
          <Button
            onClick={(e) => submit(e as unknown as FormEvent)}
            disabled={submitting}
          >
            {submitting ? "Starting…" : "Start run"}
          </Button>
        }
      />
      {error ? <ErrorBanner message={error} /> : null}
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Card className="p-4 flex flex-col gap-3">
          <Field label="Preset">
            <SimpleSelect
              value={presetId || "__adhoc__"}
              onValueChange={(value) =>
                setPresetId(value === "__adhoc__" ? "" : value)
              }
              options={[
                { value: "__adhoc__", label: "Ad-hoc (build from scratch)" },
                ...presets.presets.map((preset) => ({
                  value: preset.id,
                  label: preset.name,
                })),
              ]}
            />
          </Field>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Field label="Endpoint">
              <SimpleSelect
                value={endpoint}
                onValueChange={setEndpoint}
                disabled={Boolean(presetId)}
                options={endpointSuites.map((suite) => ({
                  value: suite.relativePath,
                  label: suite.relativePath,
                }))}
                emptyLabel="No endpoint suites found"
              />
            </Field>
            <Field label="Personas">
              <SimpleSelect
                value={personas}
                onValueChange={setPersonas}
                disabled={Boolean(presetId)}
                options={personaSuites.map((suite) => ({
                  value: suite.relativePath,
                  label: suite.relativePath,
                }))}
                emptyLabel="No persona suites found"
              />
            </Field>
            <Field label="Rubric">
              <SimpleSelect
                value={rubric}
                onValueChange={setRubric}
                disabled={Boolean(presetId)}
                options={rubricSuites.map((suite) => ({
                  value: suite.relativePath,
                  label: suite.relativePath,
                }))}
                emptyLabel="No rubric suites found"
              />
            </Field>
          </div>
        </Card>
        {!presetId && (
          <Card className="overflow-hidden">
            <div className="p-3 border-b border-border flex items-center justify-between">
              <div>
                <div className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">
                  Scenarios
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  {scenarios.scenarios.length} available
                </div>
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={() =>
                  setSelected(
                    new Set(
                      scenarios.scenarios.map(
                        (scenario) => `${scenario.sourcePath}::${scenario.id}`,
                      ),
                    ),
                  )
                }
              >
                Select all
              </Button>
            </div>
            <div className="max-h-[420px] overflow-y-auto divide-y divide-border">
              {scenarios.scenarios.map((scenario) => {
                const key = `${scenario.sourcePath}::${scenario.id}`;
                const checked = selected.has(key);
                return (
                  <div
                    key={key}
                    className={`flex items-start gap-3 px-3 py-2.5 hover:bg-secondary ${checked ? "bg-primary/5" : ""}`}
                  >
                    <label className="flex items-start gap-3 flex-1 min-w-0 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(event) => {
                          const next = new Set(selected);
                          if (event.currentTarget.checked) {
                            next.add(key);
                          } else {
                            next.delete(key);
                          }
                          setSelected(next);
                        }}
                        className="size-4 mt-0.5 accent-primary shrink-0"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-baseline gap-2 flex-wrap">
                          <span className="text-sm font-medium text-foreground">
                            {scenario.name || scenario.id}
                          </span>
                          <span className="font-mono text-[11px] text-muted-foreground">
                            {scenario.id}
                          </span>
                          {scenario.priority ? (
                            <Tag tone="info">{scenario.priority}</Tag>
                          ) : null}
                        </div>
                        {scenario.description ? (
                          <div className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                            {scenario.description}
                          </div>
                        ) : null}
                        <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                          {scenario.tags.slice(0, 5).map((tag) => (
                            <Tag key={tag}>{tag}</Tag>
                          ))}
                          <span className="font-mono text-[10px] text-muted-foreground/70">
                            {scenario.sourcePath}
                          </span>
                        </div>
                      </div>
                    </label>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="shrink-0 self-start"
                      onClick={() =>
                        setDetailsTarget({
                          file: scenario.sourcePath,
                          id: scenario.id,
                          name: scenario.name,
                          description: scenario.description,
                          tags: scenario.tags,
                          priority: scenario.priority,
                        })
                      }
                    >
                      Details
                    </Button>
                  </div>
                );
              })}
            </div>
          </Card>
        )}
        <Card className="p-4 flex flex-col gap-3">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Field label="Label" hint="Shown in the run list.">
              <TextInput
                value={label}
                onChange={(e) => setLabel(e.currentTarget.value)}
                maxLength={200}
              />
            </Field>
            <Field label="Repeat">
              <TextInput
                type="number"
                min={1}
                value={repeat}
                onChange={(e) => setRepeat(Number(e.currentTarget.value))}
              />
            </Field>
            <Field label="Parallel limit">
              <TextInput
                type="number"
                min={1}
                value={parallelLimit}
                onChange={(e) =>
                  setParallelLimit(Number(e.currentTarget.value))
                }
                disabled={!parallelEnabled}
              />
            </Field>
          </div>
          <div className="flex flex-wrap gap-4 items-center">
            <Checkbox checked={dryRun} onChange={setDryRun} label="Dry run" />
            <Checkbox
              checked={parallelEnabled}
              onChange={setParallelEnabled}
              label="Parallel"
            />
            {!presetId ? (
              <Checkbox
                checked={saveAsPreset}
                onChange={setSaveAsPreset}
                label="Save as preset"
              />
            ) : null}
          </div>
          {saveAsPreset && !presetId ? (
            <Field label="Preset name">
              <TextInput
                value={presetName}
                onChange={(e) => setPresetName(e.currentTarget.value)}
                placeholder="e.g. Smoke suite"
              />
            </Field>
          ) : null}
        </Card>
        <div className="flex justify-end">
          <Button type="submit" disabled={submitting}>
            {submitting ? "Starting…" : "Start run"}
          </Button>
        </div>
      </form>
      <ScenarioDetailsModal
        open={detailsTarget != null}
        target={detailsTarget}
        request={request}
        onClose={() => setDetailsTarget(null)}
      />
    </>
  );
}

function buildLaunchOptions(preset: Preset): RunLaunchOptions {
  return {
    presetId: preset.id,
    presetName: preset.name,
    defaults: {
      endpoint: preset.endpoint,
      personas: preset.personas,
      rubric: preset.rubric,
      parallelEnabled: preset.parallel.enabled,
      parallelLimit: preset.parallel.limit,
      repeat: preset.repeat,
      dryRun: preset.dry_run,
    },
  };
}

function detectTransport(endpoint: string): string {
  const path = endpoint.toLowerCase();
  if (path.includes("autogpt")) return "autogpt";
  if (path.includes("openclaw")) return "openclaw";
  if (path.includes("opencode")) return "opencode";
  return "custom";
}

function PresetsView({
  request,
  navigate,
}: {
  request: ServerRequest;
  navigate: (href: string) => void;
}) {
  const [data, setData] = useState<PresetsResponse | null>(null);
  const [suites, setSuites] = useState<SuitesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [launching, setLaunching] = useState<RunLaunchOptions | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      request<PresetsResponse>("/api/presets"),
      request<SuitesResponse>("/api/suites"),
    ])
      .then(([next, nextSuites]) => {
        if (cancelled) return;
        setData(next);
        setSuites(nextSuites);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [request]);

  if (error) return <ErrorBanner message={error} />;
  if (!data) {
    return (
      <>
        <PageHeaderSkeleton withMeta />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          <CardSkeleton lines={4} />
          <CardSkeleton lines={4} />
          <CardSkeleton lines={4} />
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        eyebrow="Presets"
        title="Saved Configurations"
        meta={`${data.presets.length} preset${data.presets.length === 1 ? "" : "s"}`}
        actions={
          <a
            href="/start"
            className="inline-flex items-center justify-center gap-1.5 rounded-md font-medium border transition-colors px-3 py-1.5 text-sm bg-primary text-background border-primary hover:bg-primary/90 hover:border-primary no-underline"
          >
            New preset
          </a>
        }
      />
      {data.presets.length === 0 ? (
        <EmptyState
          title="No presets yet"
          description="Build a run on the Start tab and save it as a preset to make it repeatable."
          action={
            <a
              href="/start"
              className="inline-flex items-center justify-center gap-1.5 rounded-md font-medium border transition-colors px-3 py-1.5 text-sm bg-primary text-background border-primary hover:bg-primary/90 hover:border-primary no-underline"
            >
              Build your first preset
            </a>
          }
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {data.presets.map((preset) => {
            const transport = detectTransport(preset.endpoint);
            return (
              <Card
                key={preset.id}
                className="p-4 hover:border-border transition-colors flex flex-col"
              >
                <div className="flex items-start justify-between gap-2 mb-2">
                  <a
                    href={`/presets/${encodeURIComponent(preset.id)}`}
                    className="text-base font-semibold text-foreground hover:text-primary no-underline truncate"
                    title={preset.name}
                  >
                    {preset.name}
                  </a>
                  <Tag tone={transport === "custom" ? "default" : "info"}>
                    {transport}
                  </Tag>
                </div>
                {preset.description ? (
                  <div className="text-sm text-muted-foreground mb-3 line-clamp-2">
                    {preset.description}
                  </div>
                ) : null}
                <div className="grid grid-cols-3 gap-2 mb-3 text-xs">
                  <div>
                    <div className="text-muted-foreground/70 uppercase tracking-wider text-[10px]">
                      Scenarios
                    </div>
                    <div className="font-mono text-foreground">
                      {preset.selection.length}
                    </div>
                  </div>
                  <div>
                    <div className="text-muted-foreground/70 uppercase tracking-wider text-[10px]">
                      Repeat
                    </div>
                    <div className="font-mono text-foreground">
                      {preset.repeat}
                    </div>
                  </div>
                  <div>
                    <div className="text-muted-foreground/70 uppercase tracking-wider text-[10px]">
                      Parallel
                    </div>
                    <div className="font-mono text-foreground">
                      {preset.parallel.enabled
                        ? `×${preset.parallel.limit ?? "?"}`
                        : "off"}
                    </div>
                  </div>
                </div>
                <div className="text-xs text-muted-foreground mb-3 flex items-center gap-2 min-h-[1.25rem]">
                  {preset.last_run ? (
                    <>
                      <StatusPill run={preset.last_run} />
                      <span>{fmtDate(preset.last_run.startedAt)}</span>
                    </>
                  ) : (
                    <span className="italic text-muted-foreground/70">
                      Never run
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 mt-auto pt-3 border-t border-border">
                  <Button
                    size="sm"
                    onClick={() => setLaunching(buildLaunchOptions(preset))}
                  >
                    Launch run
                  </Button>
                  <a
                    href={`/presets/${encodeURIComponent(preset.id)}/edit`}
                    className="inline-flex items-center justify-center gap-1.5 rounded-md font-medium border transition-colors px-2.5 py-1 text-xs bg-secondary text-foreground border-border hover:bg-primary hover:border-border no-underline"
                  >
                    Edit
                  </a>
                  <a
                    href={`/presets/${encodeURIComponent(preset.id)}`}
                    className="inline-flex items-center justify-center gap-1.5 rounded-md font-medium border transition-colors px-2.5 py-1 text-xs bg-transparent text-muted-foreground border-transparent hover:bg-secondary hover:text-foreground no-underline"
                  >
                    History
                  </a>
                </div>
              </Card>
            );
          })}
        </div>
      )}
      <RunLaunchModal
        open={launching != null}
        options={launching}
        request={request}
        suites={suites}
        onClose={() => setLaunching(null)}
        onLaunched={(runId) => {
          setLaunching(null);
          navigate(`/runs/${encodeURIComponent(runId)}`);
        }}
      />
    </>
  );
}

function PresetDetailView({
  presetId,
  request,
  navigate,
}: {
  presetId: string;
  request: ServerRequest;
  navigate: (href: string) => void;
}) {
  const [preset, setPreset] = useState<PresetResponse | null>(null);
  const [runs, setRuns] = useState<PresetRunsResponse | null>(null);
  const [suites, setSuites] = useState<SuitesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [launching, setLaunching] = useState<RunLaunchOptions | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      request<PresetResponse>(`/api/presets/${encodeURIComponent(presetId)}`),
      request<PresetRunsResponse>(
        `/api/presets/${encodeURIComponent(presetId)}/runs`,
      ),
      request<SuitesResponse>("/api/suites"),
    ])
      .then(([nextPreset, nextRuns, nextSuites]) => {
        if (cancelled) return;
        setPreset(nextPreset);
        setRuns(nextRuns);
        setSuites(nextSuites);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [request, presetId]);

  const deletePreset = async () => {
    if (!confirm("Delete this preset? Past runs will remain in history.")) {
      return;
    }
    try {
      await request(`/api/presets/${encodeURIComponent(presetId)}`, {
        method: "DELETE",
      });
      navigate("/presets");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (error) return <ErrorBanner message={error} />;
  if (!preset || !runs) {
    return (
      <>
        <PageHeaderSkeleton withMeta />
        <CardSkeleton lines={4} className="mb-3" />
        <RunsTableSkeleton rows={5} selectable={false} />
      </>
    );
  }

  const transport = detectTransport(preset.preset.endpoint);

  return (
    <>
      <PageHeader
        eyebrow="Preset"
        title={preset.preset.name}
        meta={preset.preset.description ?? undefined}
        actions={
          <>
            <Button
              onClick={() => setLaunching(buildLaunchOptions(preset.preset))}
            >
              Launch run
            </Button>
            <a
              href={`/presets/${encodeURIComponent(presetId)}/edit`}
              className="inline-flex items-center justify-center gap-1.5 rounded-md font-medium border transition-colors px-3 py-1.5 text-sm bg-secondary text-foreground border-border hover:bg-primary hover:border-border no-underline"
            >
              Edit
            </a>
            <Button variant="danger" onClick={() => void deletePreset()}>
              Delete
            </Button>
          </>
        }
      />
      {preset.warnings.map((warning) => (
        <ErrorBanner
          key={`${warning.file}:${warning.id}`}
          message={warning.message}
        />
      ))}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <StatTile label="Scenarios" value={preset.preset.selection.length} />
        <StatTile label="Repeat" value={preset.preset.repeat} />
        <StatTile
          label="Parallel"
          value={
            preset.preset.parallel.enabled
              ? `×${preset.preset.parallel.limit ?? "?"}`
              : "off"
          }
        />
        <StatTile
          label="Endpoint"
          tone={transport === "custom" ? "default" : "accent"}
          value={<span className="text-base font-mono">{transport}</span>}
        />
      </div>
      <Card className="p-4 mb-6">
        <div className="text-xs uppercase tracking-wider text-muted-foreground font-semibold mb-2">
          Configuration
        </div>
        <dl className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
          <div>
            <dt className="text-muted-foreground/70 text-xs">Endpoint</dt>
            <dd className="font-mono text-foreground break-all">
              {preset.preset.endpoint}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground/70 text-xs">Personas</dt>
            <dd className="font-mono text-foreground break-all">
              {preset.preset.personas}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground/70 text-xs">Rubric</dt>
            <dd className="font-mono text-foreground break-all">
              {preset.preset.rubric}
            </dd>
          </div>
        </dl>
      </Card>
      <div className="text-xs uppercase tracking-wider text-muted-foreground font-semibold mb-2">
        Run history
      </div>
      <PresetRunHistory
        runs={runs.runs}
        navigate={navigate}
        presetName={preset.preset.name}
      />
      <RunLaunchModal
        open={launching != null}
        options={launching}
        request={request}
        suites={suites}
        onClose={() => setLaunching(null)}
        onLaunched={(runId) => {
          setLaunching(null);
          navigate(`/runs/${encodeURIComponent(runId)}`);
        }}
      />
    </>
  );
}

function describeSecretSource(status: SecretStatus | null): string {
  if (!status) return "loading…";
  if (!status.configured) return "not set";
  if (status.source === "db") return "stored on server";
  if (status.source === "env") return "from environment variable";
  return "configured";
}

function OpenRouterApiKeyForm({ request }: { request: ServerRequest }) {
  const [status, setStatus] = useState<SecretStatus | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await request<OpenRouterStatusResponse>(
        "/api/settings/secrets/open_router_api_key",
      );
      setStatus(next.open_router_api_key);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [request]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!cancelled) {
        await refresh();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  const onSave = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed) return;
    setBusy(true);
    setMessage(null);
    try {
      const next = await request<OpenRouterStatusResponse>(
        "/api/settings/secrets/open_router_api_key",
        jsonBody("PUT", { value: trimmed }),
      );
      setStatus(next.open_router_api_key);
      setDraft("");
      setError(null);
      setMessage("Saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onClear = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const next = await request<OpenRouterStatusResponse>(
        "/api/settings/secrets/open_router_api_key",
        jsonBody("DELETE"),
      );
      setStatus(next.open_router_api_key);
      setDraft("");
      setError(null);
      setMessage("Cleared.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const canClear = status?.source === "db";

  return (
    <Card className="p-4 mb-4">
      <form className="flex flex-col gap-2" onSubmit={onSave}>
        <label
          htmlFor="open-router-api-key"
          className="text-xs uppercase tracking-wider text-muted-foreground font-semibold"
        >
          OpenRouter API key
        </label>
        <div className="flex items-center gap-2">
          <TextInput
            id="open-router-api-key"
            type="password"
            value={draft}
            onChange={(event) => setDraft(event.currentTarget.value)}
            placeholder="sk-or-..."
            autoComplete="off"
          />
          <Button type="submit" disabled={busy || !draft.trim()}>
            Save
          </Button>
          {canClear ? (
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                void onClear();
              }}
            >
              Clear
            </Button>
          ) : null}
        </div>
        <div className="text-xs text-muted-foreground">
          Status: {describeSecretSource(status)}
        </div>
        {message ? <div className="text-xs text-success">{message}</div> : null}
        {error ? <div className="text-xs text-destructive">{error}</div> : null}
      </form>
    </Card>
  );
}

function SettingsView({ request }: { request: ServerRequest }) {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [ready, setReady] = useState<ReadyResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch("/healthz").then(
        (response) => response.json() as Promise<HealthResponse>,
      ),
      fetch("/readyz").then(
        (response) => response.json() as Promise<ReadyResponse>,
      ),
    ])
      .then(([nextHealth, nextReady]) => {
        if (cancelled) return;
        setHealth(nextHealth);
        setReady(nextReady);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <PageHeader eyebrow="Settings" title="Server" />
      {error ? <ErrorBanner message={error} /> : null}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <StatTile
          label="Health"
          tone={health?.status === "ok" ? "success" : "default"}
          value={
            <span className="text-base font-mono">{health?.status ?? "—"}</span>
          }
        />
        <StatTile
          label="Readiness"
          tone={ready?.status === "ready" ? "success" : "default"}
          value={
            <span className="text-base font-mono">{ready?.status ?? "—"}</span>
          }
        />
        <StatTile
          label="Version"
          value={
            <span className="text-base font-mono">
              {health?.version ?? "—"}
            </span>
          }
        />
        <StatTile
          label="Database"
          value={
            <span className="text-base font-mono">
              {ready?.db_url ? "sqlite" : "—"}
            </span>
          }
        />
      </div>
      <OpenRouterApiKeyForm request={request} />
    </>
  );
}

function ServerDashboard() {
  const { pathname, navigate } = usePathname();
  const request = useServerRequest();

  useLocalLinkInterception(navigate);

  const content = (() => {
    if (pathname === "/" || pathname === "/index.html") {
      return <OverviewView request={request} navigate={navigate} />;
    }
    if (pathname === "/runs") {
      return <RunsView request={request} navigate={navigate} />;
    }
    if (pathname === "/start") {
      return <StartRunView request={request} navigate={navigate} />;
    }
    if (pathname === "/presets") {
      return <PresetsView request={request} navigate={navigate} />;
    }
    if (pathname === "/suites") {
      return <SuitesView request={request} />;
    }
    if (pathname === "/endpoints") {
      return <EndpointsView request={request} />;
    }
    if (pathname === "/settings") {
      return <SettingsView request={request} />;
    }
    if (pathname === "/compare") {
      return <CompareView />;
    }
    if (pathname === "/score") {
      return <ScoreIndexView request={request} navigate={navigate} />;
    }
    const scoreSessionMatch = pathname.match(/^\/score\/([^/]+)\/([^/]+)$/);
    if (scoreSessionMatch) {
      return (
        <ScoreSessionView
          rubricId={decodeURIComponent(scoreSessionMatch[1] ?? "")}
          dimensionId={decodeURIComponent(scoreSessionMatch[2] ?? "")}
          request={request}
          navigate={navigate}
        />
      );
    }
    const scenarioMatch = pathname.match(
      /^\/runs\/([^/]+)\/scenarios\/([0-9]+)$/,
    );
    if (scenarioMatch) {
      return (
        <ScenarioDetailView
          runId={decodeURIComponent(scenarioMatch[1] ?? "")}
          ordinal={scenarioMatch[2] ?? "0"}
          request={request}
        />
      );
    }
    const runMatch = pathname.match(/^\/runs\/([^/]+)$/);
    if (runMatch) {
      return (
        <RunDetailView
          runId={decodeURIComponent(runMatch[1] ?? "")}
          request={request}
          navigate={navigate}
        />
      );
    }
    const presetEditMatch = pathname.match(/^\/presets\/([^/]+)\/edit$/);
    if (presetEditMatch) {
      return (
        <PresetEditorView
          presetId={decodeURIComponent(presetEditMatch[1] ?? "")}
          request={request}
          navigate={navigate}
        />
      );
    }
    const presetMatch = pathname.match(/^\/presets\/([^/]+)$/);
    if (presetMatch) {
      return (
        <PresetDetailView
          presetId={decodeURIComponent(presetMatch[1] ?? "")}
          request={request}
          navigate={navigate}
        />
      );
    }
    return <ErrorBanner message="Page not found." />;
  })();

  type NavItem = {
    href: string;
    label: string;
    isActive: (p: string) => boolean;
  };
  const navItems: NavItem[] = [
    {
      href: "/",
      label: "Overview",
      isActive: (p) => p === "/" || p === "/index.html",
    },
    { href: "/start", label: "Start", isActive: (p) => p === "/start" },
    {
      href: "/runs",
      label: "Runs",
      isActive: (p) => p === "/runs" || p.startsWith("/runs/"),
    },
    {
      href: "/score",
      label: "Score",
      isActive: (p) => p === "/score" || p.startsWith("/score/"),
    },
    {
      href: "/presets",
      label: "Presets",
      isActive: (p) => p === "/presets" || p.startsWith("/presets/"),
    },
    {
      href: "/suites",
      label: "Suites",
      isActive: (p) => p.startsWith("/suites"),
    },
    {
      href: "/endpoints",
      label: "Endpoints",
      isActive: (p) => p.startsWith("/endpoints"),
    },
    {
      href: "/settings",
      label: "Settings",
      isActive: (p) => p === "/settings",
    },
  ];

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-30 border-b border-border bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/65">
        <div className="mx-auto max-w-[1280px] px-6 h-14 flex items-center justify-between gap-6">
          <a
            href="/"
            className="flex items-center gap-2.5 no-underline text-foreground"
          >
            <span className="inline-block size-2 rounded-full bg-primary shadow-[0_0_0_4px_hsl(var(--primary)/0.12)]" />
            <span className="text-sm font-semibold tracking-tight">
              AgentProbe
            </span>
          </a>
          <div className="flex items-center gap-1">
            <nav className="hidden md:flex items-center gap-0.5">
              {navItems.map((item) => {
                const active = item.isActive(pathname);
                return (
                  <a
                    key={item.href}
                    href={item.href}
                    className={`relative px-3 h-14 inline-flex items-center text-sm transition-colors no-underline ${
                      active
                        ? "text-foreground font-medium"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {item.label}
                    {active ? (
                      <span className="absolute bottom-[-1px] left-3 right-3 h-px bg-primary" />
                    ) : null}
                  </a>
                );
              })}
            </nav>
            <nav className="md:hidden flex items-center gap-1 overflow-x-auto">
              {navItems.map((item) => {
                const active = item.isActive(pathname);
                return (
                  <a
                    key={item.href}
                    href={item.href}
                    className={`px-2.5 h-8 inline-flex items-center rounded-md text-xs transition-colors no-underline ${
                      active
                        ? "bg-secondary text-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {item.label}
                  </a>
                );
              })}
            </nav>
            <div className="ml-2 pl-2 border-l border-border">
              <ThemeToggle />
            </div>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-[1280px] px-6 py-8">{content}</main>
    </div>
  );
}

function LiveDashboard() {
  const { data, error } = useDashboard();
  const [selectedOrdinal, setSelectedOrdinal] = useState<number | null>(null);

  if (error && !data) {
    return (
      <div style={{ padding: 48, textAlign: "center", color: "var(--muted)" }}>
        <div style={{ fontSize: 16, marginBottom: 8 }}>
          Waiting for run to start...
        </div>
        <div style={{ fontSize: 12 }}>{error}</div>
      </div>
    );
  }

  if (!data) {
    return (
      <div style={{ padding: 48, textAlign: "center", color: "var(--muted)" }}>
        Loading...
      </div>
    );
  }

  const selectedDetail =
    selectedOrdinal != null ? (data.details[selectedOrdinal] ?? null) : null;

  return (
    <>
      <div className="header">
        <h1>AgentProbe Live Dashboard</h1>
        <span className="live-badge">
          <span className={data.all_done ? "done-dot" : "live-dot"} />
          {data.all_done ? "COMPLETE" : "LIVE"}
        </span>
      </div>

      <StatsBar data={data} />
      <ProgressBar data={data} />
      <ScenarioTable data={data} onSelect={setSelectedOrdinal} />
      <AveragesTable
        averages={data.averages}
        onSelectRun={setSelectedOrdinal}
      />

      <div className="footer">
        AgentProbe Dashboard &middot; {data.done}/{data.total} scenarios
      </div>

      {selectedDetail && (
        <DetailPanel
          detail={selectedDetail}
          onClose={() => setSelectedOrdinal(null)}
        />
      )}
    </>
  );
}

function AppContent() {
  const [mode, setMode] = useState<AppMode>("detecting");
  const [_pathname, setPathname] = useState<string>(
    typeof window !== "undefined" ? window.location.pathname : "/",
  );

  useEffect(() => {
    const onPopState = () => setPathname(window.location.pathname);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    let cancelled = false;
    // Live mode is opt-in via a window flag the CLI live-dashboard server
    // injects; otherwise default to the agentprobe-server UX. Probing for
    // /api/state was noisy in DevTools and (worse) caused 502s from a missing
    // dev-mode proxy backend to flip us into live mode, which then polled
    // /api/state on a 2s loop.
    const live = (window as { __AGENTPROBE_LIVE__?: boolean })
      .__AGENTPROBE_LIVE__;
    if (live) {
      setMode("live");
      return undefined;
    }
    // Confirm server-mode HTTP reachability so the auth banner and other
    // server views don't blank out silently if the API is unreachable.
    fetch("/api/session", { headers: { accept: "application/json" } }).finally(
      () => {
        if (!cancelled) setMode("server");
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  if (mode === "detecting") {
    return <Loading label="Starting dashboard…" />;
  }
  return mode === "live" ? <LiveDashboard /> : <ServerDashboard />;
}

export function App() {
  return (
    <DashboardQueryProvider>
      <AppContent />
    </DashboardQueryProvider>
  );
}

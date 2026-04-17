import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AveragesTable } from "./components/AveragesTable.tsx";
import { CompareView } from "./components/CompareView.tsx";
import { ConversationView } from "./components/ConversationView.tsx";
import { DetailPanel } from "./components/DetailPanel.tsx";
import { ProgressBar } from "./components/ProgressBar.tsx";
import { RubricView } from "./components/RubricView.tsx";
import { ScenarioTable } from "./components/ScenarioTable.tsx";
import { StatsBar } from "./components/StatsBar.tsx";
import { useDashboard } from "./hooks/useDashboard.ts";
import type {
  DashboardData,
  DimensionScore,
  ScenarioDetail,
  ScenarioState,
} from "./types.ts";

const SERVER_TOKEN_KEY = "agentprobe:server-token";

type AppMode = "detecting" | "live" | "server";

type AggregateCounts = {
  scenarioTotal: number;
  scenarioPassedCount: number;
  scenarioFailedCount: number;
  scenarioHarnessFailedCount?: number;
  scenarioErroredCount: number;
};

type RunSummary = {
  runId: string;
  status: string;
  passed?: boolean | null;
  exitCode?: number | null;
  preset?: string | null;
  label?: string | null;
  trigger?: string | null;
  cancelledAt?: string | null;
  presetId?: string | null;
  startedAt: string;
  completedAt?: string | null;
  suiteFingerprint?: string | null;
  aggregateCounts: AggregateCounts;
};

type ServerScenario = {
  ordinal: number;
  scenarioId: string;
  scenarioName: string;
  userId?: string | null;
  status: string;
  passed?: boolean | null;
  failureKind?: "agent" | "harness" | null;
  overallScore?: number | null;
  passThreshold?: number | null;
  judge?: {
    provider?: string | null;
    model?: string | null;
    temperature?: number | null;
    maxTokens?: number | null;
    overallNotes?: string | null;
    output?: unknown;
  };
  turns?: Array<Record<string, unknown>>;
  toolCalls?: Array<Record<string, unknown>>;
  checkpoints?: Array<Record<string, unknown>>;
  judgeDimensionScores?: Array<Record<string, unknown>>;
  expectations?: unknown;
  error?: unknown;
  counts?: {
    turnCount: number;
    assistantTurnCount: number;
    toolCallCount: number;
    checkpointCount: number;
  };
  startedAt?: string | null;
  completedAt?: string | null;
};

type RunRecord = RunSummary & {
  scenarios: ServerScenario[];
};

type RunsResponse = {
  runs: RunSummary[];
  total: number;
  limit: number;
  offset: number;
  next_cursor: string | null;
};

type RunResponse = {
  run: RunRecord;
};

type ScenarioResponse = {
  run: Pick<
    RunSummary,
    "runId" | "status" | "passed" | "startedAt" | "completedAt"
  >;
  scenario: ServerScenario;
};

type SuiteSummary = {
  id: string;
  path: string;
  relativePath: string;
  schema: string;
  objectCount: number;
  scenarioIds: string[];
};

type ScenarioSummary = {
  suiteId: string;
  id: string;
  name: string;
  tags: string[];
  priority: string | null;
  persona: string | null;
  rubric: string | null;
  sourcePath: string;
};

type SuitesResponse = {
  data_path: string;
  scanned_at: string;
  suites: SuiteSummary[];
  errors: Array<{ path: string; message: string }>;
};

type ScenariosResponse = {
  scanned_at: string;
  scenarios: ScenarioSummary[];
};

type Preset = {
  id: string;
  name: string;
  description: string | null;
  endpoint: string;
  personas: string;
  rubric: string;
  selection: Array<{ file: string; id: string }>;
  parallel: { enabled: boolean; limit: number | null };
  repeat: number;
  dry_run: boolean;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  last_run: RunSummary | null;
};

type PresetsResponse = {
  presets: Preset[];
};

type PresetResponse = {
  preset: Preset;
  warnings: Array<{ file: string; id: string; message: string }>;
};

type PresetRunsResponse = {
  runs: RunSummary[];
};

type HealthResponse = {
  status: string;
  version?: string;
  uptime_seconds?: number;
};

type ReadyResponse = {
  status: string;
  data_path?: string;
  db_url?: string | null;
  reason?: string;
};

type ServerRequest = <T>(path: string, init?: RequestInit) => Promise<T>;

class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

function readStoredToken(): string {
  try {
    return window.sessionStorage.getItem(SERVER_TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeStoredToken(token: string): void {
  try {
    if (token) {
      window.sessionStorage.setItem(SERVER_TOKEN_KEY, token);
    } else {
      window.sessionStorage.removeItem(SERVER_TOKEN_KEY);
    }
  } catch {
    // Storage can be unavailable in locked-down browser contexts.
  }
}

function errorMessageFromBody(body: unknown, fallback: string): string {
  if (!body || typeof body !== "object") {
    return fallback;
  }
  const error = (body as Record<string, unknown>).error;
  if (!error || typeof error !== "object") {
    return fallback;
  }
  const message = (error as Record<string, unknown>).message;
  return typeof message === "string" && message ? message : fallback;
}

async function api<T>(
  path: string,
  token: string,
  init: RequestInit = {},
): Promise<T> {
  const headers: Record<string, string> = {
    accept: "application/json",
  };
  const incomingHeaders = new Headers(init.headers);
  for (const [key, value] of incomingHeaders.entries()) {
    headers[key] = value;
  }
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }

  const response = await fetch(path, { ...init, headers });
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!response.ok) {
    throw new ApiError(
      response.status,
      errorMessageFromBody(body, `HTTP ${response.status}`),
    );
  }
  return body as T;
}

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

function Loading({ label = "Loading..." }: { label?: string }) {
  return <div className="server-empty">{label}</div>;
}

function ErrorBanner({ message }: { message: string }) {
  return <div className="server-error">{message}</div>;
}

function StatusPill({ run }: { run: RunSummary }) {
  const cls =
    run.status === "running"
      ? "status-running"
      : run.passed === true
        ? "status-pass"
        : run.passed === false
          ? "status-fail"
          : "status-pending";
  const label =
    run.status === "completed" && run.passed != null
      ? run.passed
        ? "pass"
        : "fail"
      : run.status;
  return (
    <span className={`${cls} status-badge`}>
      <span>{label.toUpperCase()}</span>
    </span>
  );
}

function RunsTable({ runs }: { runs: RunSummary[] }) {
  if (runs.length === 0) {
    return <div className="server-empty">No runs recorded.</div>;
  }
  return (
    <table>
      <thead>
        <tr>
          <th>Run</th>
          <th>Status</th>
          <th>Preset</th>
          <th>Started</th>
          <th style={{ textAlign: "right" }}>Passed</th>
        </tr>
      </thead>
      <tbody>
        {runs.map((run) => (
          <tr key={run.runId} className="clickable-row">
            <td className="id-cell">
              <a href={`/runs/${encodeURIComponent(run.runId)}`}>{run.runId}</a>
            </td>
            <td>
              <StatusPill run={run} />
            </td>
            <td>{run.preset ?? "-"}</td>
            <td>{run.startedAt}</td>
            <td className="score-cell">
              {run.aggregateCounts.scenarioPassedCount}/
              {run.aggregateCounts.scenarioTotal}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TokenForm({
  token,
  onTokenChange,
  authRequired,
}: {
  token: string;
  onTokenChange: (token: string) => void;
  authRequired?: boolean;
}) {
  const [draft, setDraft] = useState(token);

  useEffect(() => {
    setDraft(token);
  }, [token]);

  return (
    <form
      className="server-token-form"
      onSubmit={(event) => {
        event.preventDefault();
        onTokenChange(draft.trim());
      }}
    >
      <label htmlFor="server-token">
        {authRequired ? "Bearer token required" : "Bearer token"}
      </label>
      <div className="server-token-row">
        <input
          id="server-token"
          type="password"
          value={draft}
          onChange={(event) => setDraft(event.currentTarget.value)}
          placeholder="token"
        />
        <button type="submit">Save</button>
        {token && (
          <button
            type="button"
            className="secondary"
            onClick={() => onTokenChange("")}
          >
            Clear
          </button>
        )}
      </div>
    </form>
  );
}

function useServerRequest(token: string, onAuthRequired: () => void) {
  return useCallback(
    async <T,>(path: string, init?: RequestInit): Promise<T> => {
      try {
        return await api<T>(path, token, init);
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          onAuthRequired();
        }
        throw error;
      }
    },
    [token, onAuthRequired],
  );
}

function OverviewView({ request }: { request: ServerRequest }) {
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
  if (!runs || !suites) return <Loading />;

  const passed = runs.runs.filter((run) => run.passed === true).length;
  const failed = runs.runs.filter((run) => run.passed === false).length;

  return (
    <>
      <div className="stats">
        <div className="stat">
          <div className="stat-value">{runs.total}</div>
          <div className="stat-label">Runs</div>
        </div>
        <div className="stat">
          <div className="stat-value" style={{ color: "var(--green)" }}>
            {passed}
          </div>
          <div className="stat-label">Recent Passed</div>
        </div>
        <div className="stat">
          <div className="stat-value" style={{ color: "var(--red)" }}>
            {failed}
          </div>
          <div className="stat-label">Recent Failed</div>
        </div>
        <div className="stat">
          <div className="stat-value" style={{ color: "var(--indigo)" }}>
            {suites.suites.length}
          </div>
          <div className="stat-label">Suites</div>
        </div>
      </div>
      <div className="section-title">Latest Runs</div>
      <RunsTable runs={runs.runs} />
    </>
  );
}

function RunsView({ request }: { request: ServerRequest }) {
  const [data, setData] = useState<RunsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    request<RunsResponse>("/api/runs")
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
  }, [request]);

  if (error) return <ErrorBanner message={error} />;
  if (!data) return <Loading />;

  return (
    <>
      <div className="section-title">Runs</div>
      <RunsTable runs={data.runs} />
    </>
  );
}

export function RunDetailView({
  runId,
  request,
  token,
}: {
  runId: string;
  request: ServerRequest;
  token: string;
}) {
  const [run, setRun] = useState<RunRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedOrdinal, setSelectedOrdinal] = useState<number | null>(null);
  const [cancelling, setCancelling] = useState(false);
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
    setSelectedOrdinal(null);
    void loadRun();
  }, [loadRun]);

  useEffect(() => {
    const tokenQuery = token
      ? `?access_token=${encodeURIComponent(token)}`
      : "";
    const events = new EventSource(
      `/api/runs/${encodeURIComponent(runId)}/events${tokenQuery}`,
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
  }, [runId, token]);

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
  const selectedDetail =
    selectedOrdinal != null && dashboardData
      ? (dashboardData.details[selectedOrdinal] ?? null)
      : null;

  if (error) return <ErrorBanner message={error} />;
  if (!run || !dashboardData) return <Loading />;

  return (
    <>
      <div className="server-heading-row">
        <div>
          <div className="server-eyebrow">Run</div>
          <h1>{run.runId}</h1>
        </div>
        <div className="server-form-actions">
          {run.status === "running" && (
            <button
              type="button"
              className="secondary"
              onClick={() => void cancelRun()}
              disabled={cancelling}
            >
              {cancelling ? "Cancelling..." : "Cancel"}
            </button>
          )}
          <a href={`/api/runs/${encodeURIComponent(run.runId)}/report.html`}>
            HTML report
          </a>
        </div>
      </div>
      <StatsBar data={dashboardData} />
      <ProgressBar data={dashboardData} />
      <ScenarioTable data={dashboardData} onSelect={setSelectedOrdinal} />
      <div className="server-link-strip">
        {run.scenarios.map((scenario) => (
          <a
            key={scenario.ordinal}
            href={`/runs/${encodeURIComponent(run.runId)}/scenarios/${
              scenario.ordinal
            }`}
          >
            Scenario {scenario.ordinal}
          </a>
        ))}
      </div>
      <AveragesTable
        averages={dashboardData.averages}
        onSelectRun={setSelectedOrdinal}
      />
      {selectedDetail && (
        <DetailPanel
          detail={selectedDetail}
          onClose={() => setSelectedOrdinal(null)}
        />
      )}
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
  if (!data) return <Loading />;

  const detail = scenarioDetail(data.scenario);

  return (
    <>
      <div className="server-heading-row">
        <div>
          <div className="server-eyebrow">
            <a href={`/runs/${encodeURIComponent(data.run.runId)}`}>
              {data.run.runId}
            </a>
          </div>
          <h1>{detail.scenario_name}</h1>
        </div>
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
      </div>
      <div className="server-detail-grid">
        <section>
          <div className="section-title">Conversation</div>
          <ConversationView detail={detail} />
        </section>
        <section>
          <div className="section-title">Rubric</div>
          <RubricView detail={detail} />
        </section>
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
  if (!suites || !scenarios) return <Loading />;

  return (
    <>
      <div className="server-heading-row">
        <div>
          <div className="server-eyebrow">Data Root</div>
          <h1>{suites.data_path}</h1>
        </div>
      </div>
      {suites.errors.length > 0 && (
        <ErrorBanner
          message={`${suites.errors.length} suite files had validation errors.`}
        />
      )}
      <div className="section-title">Suites</div>
      <table>
        <thead>
          <tr>
            <th>Suite</th>
            <th>Schema</th>
            <th>Path</th>
            <th style={{ textAlign: "right" }}>Objects</th>
          </tr>
        </thead>
        <tbody>
          {suites.suites.map((suite) => (
            <tr key={suite.id}>
              <td className="id-cell">{suite.id}</td>
              <td>{suite.schema}</td>
              <td>{suite.relativePath}</td>
              <td className="score-cell">{suite.objectCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="section-title">Scenarios</div>
      <table>
        <thead>
          <tr>
            <th>Scenario</th>
            <th>Name</th>
            <th>Suite</th>
            <th>Tags</th>
            <th>Rubric</th>
          </tr>
        </thead>
        <tbody>
          {scenarios.scenarios.map((scenario) => (
            <tr key={`${scenario.suiteId}:${scenario.id}`}>
              <td className="id-cell">{scenario.id}</td>
              <td>{scenario.name}</td>
              <td>{scenario.suiteId}</td>
              <td>{scenario.tags.join(", ") || "-"}</td>
              <td>{scenario.rubric ?? "-"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function jsonBody(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function StartRunView({
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
  if (!suites || !scenarios || !presets) return <Loading />;

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
      <div className="server-heading-row">
        <div>
          <div className="server-eyebrow">Start</div>
          <h1>Run Builder</h1>
        </div>
      </div>
      <form className="server-form" onSubmit={submit}>
        <label>
          Preset
          <select
            value={presetId}
            onChange={(e) => setPresetId(e.currentTarget.value)}
          >
            <option value="">Ad-hoc</option>
            {presets.presets.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.name}
              </option>
            ))}
          </select>
        </label>
        <div className="server-form-grid">
          <label>
            Endpoint
            <select
              value={endpoint}
              onChange={(e) => setEndpoint(e.currentTarget.value)}
              disabled={Boolean(presetId)}
            >
              {endpointSuites.map((suite) => (
                <option key={suite.id} value={suite.relativePath}>
                  {suite.relativePath}
                </option>
              ))}
            </select>
          </label>
          <label>
            Personas
            <select
              value={personas}
              onChange={(e) => setPersonas(e.currentTarget.value)}
              disabled={Boolean(presetId)}
            >
              {personaSuites.map((suite) => (
                <option key={suite.id} value={suite.relativePath}>
                  {suite.relativePath}
                </option>
              ))}
            </select>
          </label>
          <label>
            Rubric
            <select
              value={rubric}
              onChange={(e) => setRubric(e.currentTarget.value)}
              disabled={Boolean(presetId)}
            >
              {rubricSuites.map((suite) => (
                <option key={suite.id} value={suite.relativePath}>
                  {suite.relativePath}
                </option>
              ))}
            </select>
          </label>
        </div>
        {!presetId && (
          <div className="scenario-picker">
            <div className="server-form-actions">
              <span className="section-label">Scenarios</span>
              <button
                type="button"
                className="secondary"
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
              </button>
            </div>
            {scenarios.scenarios.slice(0, 80).map((scenario) => {
              const key = `${scenario.sourcePath}::${scenario.id}`;
              return (
                <label className="check-row" key={key}>
                  <input
                    type="checkbox"
                    checked={selected.has(key)}
                    onChange={(event) => {
                      const next = new Set(selected);
                      if (event.currentTarget.checked) {
                        next.add(key);
                      } else {
                        next.delete(key);
                      }
                      setSelected(next);
                    }}
                  />
                  <span>{scenario.id}</span>
                  <span>{scenario.sourcePath}</span>
                </label>
              );
            })}
          </div>
        )}
        <div className="server-form-grid">
          <label>
            Label
            <input
              value={label}
              onChange={(e) => setLabel(e.currentTarget.value)}
            />
          </label>
          <label>
            Repeat
            <input
              type="number"
              min={1}
              value={repeat}
              onChange={(e) => setRepeat(Number(e.currentTarget.value))}
            />
          </label>
          <label>
            Parallel limit
            <input
              type="number"
              min={1}
              value={parallelLimit}
              onChange={(e) => setParallelLimit(Number(e.currentTarget.value))}
              disabled={!parallelEnabled}
            />
          </label>
        </div>
        <div className="server-toggle-row">
          <label>
            <input
              type="checkbox"
              checked={dryRun}
              onChange={(e) => setDryRun(e.currentTarget.checked)}
            />
            Dry run
          </label>
          <label>
            <input
              type="checkbox"
              checked={parallelEnabled}
              onChange={(e) => setParallelEnabled(e.currentTarget.checked)}
            />
            Parallel
          </label>
          {!presetId && (
            <label>
              <input
                type="checkbox"
                checked={saveAsPreset}
                onChange={(e) => setSaveAsPreset(e.currentTarget.checked)}
              />
              Save preset
            </label>
          )}
        </div>
        {saveAsPreset && !presetId && (
          <label>
            Preset name
            <input
              value={presetName}
              onChange={(e) => setPresetName(e.currentTarget.value)}
            />
          </label>
        )}
        <div className="server-form-actions">
          <button type="submit" disabled={submitting}>
            {submitting ? "Starting..." : "Start run"}
          </button>
        </div>
      </form>
    </>
  );
}

function PresetsView({
  request,
  navigate,
}: {
  request: ServerRequest;
  navigate: (href: string) => void;
}) {
  const [data, setData] = useState<PresetsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    request<PresetsResponse>("/api/presets")
      .then((next) => {
        if (cancelled) return;
        setData(next);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [request]);

  const runPreset = async (preset: Preset) => {
    try {
      const response = await request<{ run_id: string }>(
        `/api/presets/${encodeURIComponent(preset.id)}/runs`,
        jsonBody("POST"),
      );
      navigate(`/runs/${encodeURIComponent(response.run_id)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (error) return <ErrorBanner message={error} />;
  if (!data) return <Loading />;

  return (
    <>
      <div className="server-heading-row">
        <div>
          <div className="server-eyebrow">Presets</div>
          <h1>Saved Runs</h1>
        </div>
        <a href="/start">New run</a>
      </div>
      {data.presets.length === 0 ? (
        <div className="server-empty">No presets saved.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Scenarios</th>
              <th>Repeat</th>
              <th>Last run</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data.presets.map((preset) => (
              <tr key={preset.id}>
                <td className="id-cell">
                  <a href={`/presets/${encodeURIComponent(preset.id)}`}>
                    {preset.name}
                  </a>
                </td>
                <td>{preset.selection.length}</td>
                <td>{preset.repeat}</td>
                <td>{preset.last_run?.status ?? "-"}</td>
                <td className="score-cell">
                  <button type="button" onClick={() => void runPreset(preset)}>
                    Run
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
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
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      request<PresetResponse>(`/api/presets/${encodeURIComponent(presetId)}`),
      request<PresetRunsResponse>(
        `/api/presets/${encodeURIComponent(presetId)}/runs`,
      ),
    ])
      .then(([nextPreset, nextRuns]) => {
        if (cancelled) return;
        setPreset(nextPreset);
        setRuns(nextRuns);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [request, presetId]);

  const runAgain = async () => {
    try {
      const response = await request<{ run_id: string }>(
        `/api/presets/${encodeURIComponent(presetId)}/runs`,
        jsonBody("POST"),
      );
      navigate(`/runs/${encodeURIComponent(response.run_id)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const deletePreset = async () => {
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
  if (!preset || !runs) return <Loading />;

  return (
    <>
      <div className="server-heading-row">
        <div>
          <div className="server-eyebrow">Preset</div>
          <h1>{preset.preset.name}</h1>
        </div>
        <div className="server-form-actions">
          <button type="button" onClick={() => void runAgain()}>
            Run
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => void deletePreset()}
          >
            Delete
          </button>
        </div>
      </div>
      {preset.warnings.map((warning) => (
        <ErrorBanner
          key={`${warning.file}:${warning.id}`}
          message={warning.message}
        />
      ))}
      <div className="server-settings">
        <div className="stat">
          <div className="stat-value">{preset.preset.selection.length}</div>
          <div className="stat-label">Scenarios</div>
        </div>
        <div className="stat">
          <div className="stat-value">{preset.preset.repeat}</div>
          <div className="stat-label">Repeat</div>
        </div>
        <div className="stat">
          <div className="stat-value">
            {preset.preset.dry_run ? "on" : "off"}
          </div>
          <div className="stat-label">Dry Run</div>
        </div>
      </div>
      <div className="section-title">Selection</div>
      <table>
        <thead>
          <tr>
            <th>Scenario</th>
            <th>File</th>
          </tr>
        </thead>
        <tbody>
          {preset.preset.selection.map((item) => (
            <tr key={`${item.file}:${item.id}`}>
              <td className="id-cell">{item.id}</td>
              <td>{item.file}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="section-title">Runs</div>
      {runs.runs.length >= 2 && (
        <p className="compare-cta">
          <a
            href={`/compare?run_ids=${encodeURIComponent(runs.runs[0]?.runId ?? "")},${encodeURIComponent(runs.runs[1]?.runId ?? "")}`}
          >
            Compare last two runs →
          </a>
        </p>
      )}
      <RunsTable runs={runs.runs} />
    </>
  );
}

function SettingsView({
  token,
  onTokenChange,
}: {
  token: string;
  onTokenChange: (token: string) => void;
}) {
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
      {error && <ErrorBanner message={error} />}
      <div className="server-settings">
        <div className="stat">
          <div className="stat-value">{health?.status ?? "-"}</div>
          <div className="stat-label">Health</div>
        </div>
        <div className="stat">
          <div className="stat-value">{ready?.status ?? "-"}</div>
          <div className="stat-label">Readiness</div>
        </div>
        <div className="stat">
          <div className="stat-value">{health?.version ?? "-"}</div>
          <div className="stat-label">Version</div>
        </div>
        <div className="stat">
          <div className="stat-value">{ready?.db_url ? "sqlite" : "-"}</div>
          <div className="stat-label">Database</div>
        </div>
      </div>
      <TokenForm token={token} onTokenChange={onTokenChange} />
    </>
  );
}

function ServerDashboard() {
  const { pathname, navigate } = usePathname();
  const [token, setToken] = useState(readStoredToken);
  const [authRequired, setAuthRequired] = useState(false);
  const request = useServerRequest(
    token,
    useCallback(() => setAuthRequired(true), []),
  );

  useLocalLinkInterception(navigate);

  const onTokenChange = useCallback((nextToken: string) => {
    writeStoredToken(nextToken);
    setToken(nextToken);
    setAuthRequired(false);
  }, []);

  const content = (() => {
    if (pathname === "/" || pathname === "/index.html") {
      return <OverviewView request={request} />;
    }
    if (pathname === "/runs") {
      return <RunsView request={request} />;
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
    if (pathname === "/settings") {
      return <SettingsView token={token} onTokenChange={onTokenChange} />;
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
          token={token}
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

  return (
    <>
      <div className="header server-header">
        <div>
          <h1>AgentProbe</h1>
          <div className="server-subtitle">Server</div>
        </div>
        <nav className="server-nav">
          <a className={pathname === "/" ? "active" : ""} href="/">
            Overview
          </a>
          <a className={pathname === "/start" ? "active" : ""} href="/start">
            Start
          </a>
          <a
            className={pathname.startsWith("/runs") ? "active" : ""}
            href="/runs"
          >
            Runs
          </a>
          <a
            className={pathname.startsWith("/presets") ? "active" : ""}
            href="/presets"
          >
            Presets
          </a>
          <a
            className={pathname.startsWith("/suites") ? "active" : ""}
            href="/suites"
          >
            Suites
          </a>
          <a
            className={pathname === "/settings" ? "active" : ""}
            href="/settings"
          >
            Settings
          </a>
        </nav>
      </div>
      {authRequired && (
        <TokenForm
          token={token}
          onTokenChange={onTokenChange}
          authRequired={true}
        />
      )}
      {content}
    </>
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

export function App() {
  const [mode, setMode] = useState<AppMode>("detecting");
  const [pathname, setPathname] = useState<string>(
    typeof window !== "undefined" ? window.location.pathname : "/",
  );

  useEffect(() => {
    const onPopState = () => setPathname(window.location.pathname);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/state", { headers: { accept: "application/json" } })
      .then((response) => {
        if (cancelled) return;
        setMode(response.ok ? "live" : "server");
      })
      .catch(() => {
        if (cancelled) return;
        setMode("server");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (pathname === "/compare") {
    return <CompareView token={readStoredToken() || null} />;
  }

  if (mode === "detecting") {
    return <Loading label="Starting dashboard..." />;
  }
  return mode === "live" ? <LiveDashboard /> : <ServerDashboard />;
}

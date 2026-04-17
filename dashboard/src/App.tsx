import { useCallback, useEffect, useMemo, useState } from "react";
import { AveragesTable } from "./components/AveragesTable.tsx";
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

async function api<T>(path: string, token: string): Promise<T> {
  const headers: Record<string, string> = {
    accept: "application/json",
  };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }

  const response = await fetch(path, { headers });
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
    async <T,>(path: string): Promise<T> => {
      try {
        return await api<T>(path, token);
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

function OverviewView({
  request,
}: {
  request: <T>(path: string) => Promise<T>;
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

function RunsView({ request }: { request: <T>(path: string) => Promise<T> }) {
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

function RunDetailView({
  runId,
  request,
}: {
  runId: string;
  request: <T>(path: string) => Promise<T>;
}) {
  const [run, setRun] = useState<RunRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedOrdinal, setSelectedOrdinal] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    request<RunResponse>(`/api/runs/${encodeURIComponent(runId)}`)
      .then((data) => {
        if (cancelled) return;
        setRun(data.run);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [request, runId]);

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
        <a href={`/api/runs/${encodeURIComponent(run.runId)}/report.html`}>
          HTML report
        </a>
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
  request: <T>(path: string) => Promise<T>;
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

function SuitesView({ request }: { request: <T>(path: string) => Promise<T> }) {
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
          <div className="server-subtitle">Read-only server</div>
        </div>
        <nav className="server-nav">
          <a className={pathname === "/" ? "active" : ""} href="/">
            Overview
          </a>
          <a
            className={pathname.startsWith("/runs") ? "active" : ""}
            href="/runs"
          >
            Runs
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

  if (mode === "detecting") {
    return <Loading label="Starting dashboard..." />;
  }
  return mode === "live" ? <LiveDashboard /> : <ServerDashboard />;
}

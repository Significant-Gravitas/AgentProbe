import { type ReactNode, useCallback, useEffect, useState } from "react";
import { jsonBody } from "../api/client.ts";
import type { ServerRequest } from "../api/types.ts";
import { ConversationView } from "../components/ConversationView.tsx";
import type { ScenarioDetail, Turn } from "../types.ts";
import {
  Button,
  Card,
  ErrorBanner,
  PageHeader,
  PageHeaderSkeleton,
} from "../ui/index.tsx";

type ScaleType = "likert" | "binary" | "numeric" | "rubric_levels";
type ScoreDirection = "higher_is_better" | "lower_is_better";

type Scale = {
  type: ScaleType;
  points?: number;
  labels: Record<string, string>;
};

type Dimension = {
  id: string;
  name: string;
  weight: number;
  scale: Scale;
  scoreDirection?: ScoreDirection | null;
  unscored: number;
  pairedCount: number;
  correlation: number | null;
};

function correlationTone(correlation: number | null): {
  label: string;
  className: string;
} {
  if (correlation === null || !Number.isFinite(correlation)) {
    return {
      label: "—",
      className: "bg-secondary text-muted-foreground",
    };
  }
  const text = correlation.toFixed(2);
  if (correlation >= 0.7) {
    return {
      label: `r=${text}`,
      className:
        "bg-green-500/15 text-green-600 dark:text-green-400 border border-green-500/30",
    };
  }
  if (correlation >= 0.3) {
    return {
      label: `r=${text}`,
      className:
        "bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30",
    };
  }
  return {
    label: `r=${text}`,
    className:
      "bg-red-500/15 text-red-600 dark:text-red-400 border border-red-500/30",
  };
}

type Rubric = {
  rubricId: string;
  rubricName: string;
  totalScenarios: number;
  dimensions: Dimension[];
};

type RubricsResponse = { rubrics: Rubric[] };

type QueueToolCall = {
  turn_index: number;
  call_order: number | null;
  name: string | null;
  args: unknown;
  raw: unknown;
};

type QueueItem = {
  scenarioRunId: number;
  runId: string;
  ordinal: number;
  scenarioId: string;
  scenarioName: string;
  personaId: string;
  rubricId: string;
  passThreshold: number | null;
  overallScore: number | null;
  judgeDimensionScore: number | null;
  judgeDimensionRawScore: number | null;
  scenarioDescription: string | null;
  expectations: unknown;
  turns: Array<Record<string, unknown>>;
  toolCalls: QueueToolCall[];
  targetEvents: Array<Record<string, unknown>>;
  remaining: number;
};

type NextResponse = { item: QueueItem | null };
type ScoreResponse = { ok: boolean; next: QueueItem | null };

function scaleEntries(scale: Scale): Array<{ value: number; label: string }> {
  const labels = scale.labels ?? {};
  const fromLabels = Object.keys(labels)
    .map((key) => ({ value: Number(key), label: labels[key] ?? "" }))
    .filter((entry) => Number.isFinite(entry.value));
  if (fromLabels.length > 0) {
    fromLabels.sort((a, b) => a.value - b.value);
    return fromLabels;
  }
  if (scale.type === "binary") {
    return [
      { value: 0, label: "0" },
      { value: 1, label: "1" },
    ];
  }
  const points = scale.points ?? 5;
  return Array.from({ length: points }, (_, index) => ({
    value: index + 1,
    label: String(index + 1),
  }));
}

export function ScoreIndexView({
  request,
  navigate,
}: {
  request: ServerRequest;
  navigate: (href: string) => void;
}) {
  const [data, setData] = useState<RubricsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    request<RubricsResponse>("/api/human-scoring/rubrics")
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
  if (!data) {
    return <PageHeaderSkeleton withMeta />;
  }

  if (data.rubrics.length === 0) {
    return (
      <>
        <PageHeader
          eyebrow="Human scoring"
          title="Score completed runs"
          meta="No completed runs found yet."
        />
        <Card className="p-6">
          <div className="text-sm text-muted-foreground">
            Run an evaluation, then return here to score it by hand.
          </div>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        eyebrow="Human scoring"
        title="Score completed runs"
        meta="Pick a rubric dimension. You'll click through completed runs scoring just that dimension, one chat at a time."
      />
      {data.rubrics.map((rubric) => (
        <Card key={rubric.rubricId} className="p-4 mb-3">
          <div className="flex items-baseline justify-between mb-1">
            <h3 className="text-base font-semibold tracking-tight m-0">
              {rubric.rubricName}
            </h3>
            <span className="text-xs text-muted-foreground font-mono">
              {rubric.rubricId}
            </span>
          </div>
          <div className="text-xs text-muted-foreground mb-3">
            {rubric.totalScenarios} completed scenario
            {rubric.totalScenarios === 1 ? "" : "s"}
          </div>
          <div className="space-y-2">
            {rubric.dimensions.map((dim) => {
              const done = dim.unscored === 0;
              const href = `/score/${encodeURIComponent(rubric.rubricId)}/${encodeURIComponent(dim.id)}`;
              const tone = correlationTone(dim.correlation);
              const tooltip =
                dim.correlation === null
                  ? dim.pairedCount === 0
                    ? "No human scores yet."
                    : `Only ${dim.pairedCount} paired score${dim.pairedCount === 1 ? "" : "s"} — need 2+ for correlation.`
                  : `Pearson correlation between ${dim.pairedCount} paired human and judge scores.`;
              return (
                <a
                  key={dim.id}
                  href={href}
                  className={`flex items-center justify-between gap-3 px-3 py-2.5 rounded-md border border-border bg-secondary/40 hover:border-primary hover:bg-secondary no-underline transition-colors ${done ? "opacity-50" : ""}`}
                  onClick={(event) => {
                    event.preventDefault();
                    navigate(href);
                  }}
                >
                  <div>
                    <div className="text-sm font-medium text-foreground">
                      {dim.name}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      weight {dim.weight} · {dim.scale.type}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 whitespace-nowrap">
                    <span
                      title={tooltip}
                      className={`px-2 py-0.5 rounded-full font-mono text-[11px] tabular-nums ${tone.className}`}
                    >
                      {tone.label}
                    </span>
                    <span className="font-mono text-xs text-foreground">
                      {dim.unscored}{" "}
                      <span className="text-muted-foreground">
                        / {rubric.totalScenarios} unscored
                      </span>
                    </span>
                  </div>
                </a>
              );
            })}
          </div>
        </Card>
      ))}
    </>
  );
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "string") return item.trim();
      if (item && typeof item === "object") {
        const fact = (item as Record<string, unknown>).fact;
        if (typeof fact === "string") return fact.trim();
      }
      return "";
    })
    .filter((item) => item.length > 0);
}

type Objective = {
  scenarioName: string;
  scenarioId: string;
  description: string | null;
  expectedBehavior: string | null;
  expectedOutcome: string | null;
  mustInclude: string[];
  mustNotInclude: string[];
  expectedTools: string[];
} | null;

function buildObjective(item: QueueItem): NonNullable<Objective> {
  const expectations =
    item.expectations &&
    typeof item.expectations === "object" &&
    !Array.isArray(item.expectations)
      ? (item.expectations as Record<string, unknown>)
      : {};
  const expectedBehavior = asString(expectations.expected_behavior);
  const expectedOutcome = asString(expectations.expected_outcome);
  const mustInclude = asStringArray(expectations.must_include);
  const mustNotInclude = asStringArray(expectations.must_not_include);
  const expectedTools = Array.isArray(expectations.expected_tools)
    ? expectations.expected_tools
        .map((tool) => {
          if (typeof tool === "string") return tool;
          if (tool && typeof tool === "object") {
            const name = (tool as Record<string, unknown>).name;
            return typeof name === "string" ? name : "";
          }
          return "";
        })
        .filter((name) => name.length > 0)
    : [];

  return {
    scenarioName: item.scenarioName,
    scenarioId: item.scenarioId,
    description: item.scenarioDescription,
    expectedBehavior,
    expectedOutcome,
    mustInclude,
    mustNotInclude,
    expectedTools,
  };
}

function buildScenarioDetail(item: QueueItem): ScenarioDetail {
  return {
    scenario_id: item.scenarioId,
    scenario_name: item.scenarioName,
    passed: false,
    overall_score: item.overallScore,
    pass_threshold: item.passThreshold,
    status: "completed",
    turns: (item.turns ?? []) as unknown as Turn[],
    tool_calls: (item.toolCalls ??
      []) as unknown as ScenarioDetail["tool_calls"],
    target_events: (item.targetEvents ?? []) as ScenarioDetail["target_events"],
    checkpoints: [],
    judge_dimension_scores: [],
  };
}

type PanelKey = "objective" | "rubric" | "tools";

const SIDEBAR_WIDTH_PX = 420;

function RubricPanel({
  dimension,
  onSelect,
  submitting,
}: {
  dimension: Dimension;
  onSelect: (rawScore: number) => void;
  submitting: boolean;
}) {
  const entries = scaleEntries(dimension.scale);
  return (
    <div className="space-y-3 text-sm">
      <div>
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1">
          Dimension
        </div>
        <div className="text-foreground font-medium">{dimension.name}</div>
        <div className="text-[11px] text-muted-foreground font-mono mt-0.5">
          weight {dimension.weight} · {dimension.scale.type}
          {dimension.scale.points ? ` · 1–${dimension.scale.points}` : ""}
        </div>
      </div>
      <div className="text-[11px] text-muted-foreground">
        Press <span className="font-mono">1</span>–
        <span className="font-mono">{entries.length}</span> on your keyboard, or
        click a level below.
      </div>
      <div className="space-y-2">
        {entries.map((entry) => (
          <button
            key={entry.value}
            type="button"
            disabled={submitting}
            onClick={() => onSelect(entry.value)}
            className="w-full grid grid-cols-[40px_1fr] gap-3 items-start px-3 py-2.5 rounded-md border border-border bg-secondary/40 hover:border-primary hover:bg-secondary text-left disabled:opacity-60 disabled:cursor-progress transition-colors"
          >
            <span className="text-xl font-bold font-mono text-primary text-center leading-tight pt-0.5">
              {entry.value}
            </span>
            <span className="text-xs whitespace-pre-wrap leading-relaxed">
              {entry.label}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function ObjectivePanel({ objective }: { objective: NonNullable<Objective> }) {
  return (
    <div className="space-y-4 text-sm">
      <div>
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1">
          Scenario
        </div>
        <div className="text-foreground font-medium">
          {objective.scenarioName}
        </div>
        <div className="text-[11px] text-muted-foreground font-mono mt-0.5">
          {objective.scenarioId}
        </div>
      </div>
      {objective.description ? (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1">
            Description
          </div>
          <div className="text-foreground whitespace-pre-wrap">
            {objective.description}
          </div>
        </div>
      ) : null}
      {objective.expectedBehavior ? (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1">
            Expected behavior
          </div>
          <div className="text-foreground whitespace-pre-wrap">
            {objective.expectedBehavior}
          </div>
        </div>
      ) : null}
      {objective.expectedOutcome ? (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1">
            Expected outcome
          </div>
          <div className="text-foreground whitespace-pre-wrap">
            {objective.expectedOutcome}
          </div>
        </div>
      ) : null}
      {objective.mustInclude.length > 0 ? (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1">
            Must include
          </div>
          <ul className="list-disc list-inside text-foreground space-y-0.5">
            {objective.mustInclude.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {objective.mustNotInclude.length > 0 ? (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1">
            Must not include
          </div>
          <ul className="list-disc list-inside text-foreground space-y-0.5">
            {objective.mustNotInclude.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {objective.expectedTools.length > 0 ? (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1">
            Expected tools
          </div>
          <div className="font-mono text-foreground">
            {objective.expectedTools.join(", ")}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ToolCallList({ toolCalls }: { toolCalls: QueueToolCall[] }) {
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  if (toolCalls.length === 0) {
    return (
      <div className="text-xs text-muted-foreground">
        No tool calls recorded for this run.
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {toolCalls.map((call, index) => {
        const expanded = expandedIndex === index;
        const argsJson =
          call.args === undefined || call.args === null
            ? "—"
            : JSON.stringify(call.args, null, 2);
        const rawJson =
          call.raw === undefined || call.raw === null
            ? null
            : JSON.stringify(call.raw, null, 2);
        return (
          <div
            key={`${call.turn_index}-${call.call_order ?? index}-${index}`}
            className="rounded-md border border-border bg-secondary/30"
          >
            <button
              type="button"
              onClick={() => setExpandedIndex(expanded ? null : index)}
              className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left hover:bg-secondary"
            >
              <div className="min-w-0">
                <div className="text-sm font-mono truncate">
                  {call.name ?? "(unnamed)"}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  turn {call.turn_index}
                  {call.call_order !== null
                    ? ` · order ${call.call_order}`
                    : ""}
                </div>
              </div>
              <span className="text-muted-foreground text-xs shrink-0">
                {expanded ? "▾" : "▸"}
              </span>
            </button>
            {expanded ? (
              <div className="border-t border-border px-3 py-2 space-y-2">
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
                    Args
                  </div>
                  <pre className="text-[11px] font-mono whitespace-pre-wrap break-words bg-background rounded p-2 max-h-72 overflow-auto">
                    {argsJson}
                  </pre>
                </div>
                {rawJson ? (
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
                      Raw
                    </div>
                    <pre className="text-[11px] font-mono whitespace-pre-wrap break-words bg-background rounded p-2 max-h-72 overflow-auto">
                      {rawJson}
                    </pre>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function ScrollNav() {
  return (
    <div className="fixed bottom-4 left-4 z-40 flex flex-col gap-2">
      <button
        type="button"
        onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
        className="size-10 rounded-md border border-border bg-background shadow-lg hover:bg-secondary text-foreground flex items-center justify-center transition-colors"
        aria-label="Jump to top"
        title="Jump to top"
      >
        <span className="text-lg leading-none">↑</span>
      </button>
      <button
        type="button"
        onClick={() =>
          window.scrollTo({
            top: document.documentElement.scrollHeight,
            behavior: "smooth",
          })
        }
        className="size-10 rounded-md border border-border bg-background shadow-lg hover:bg-secondary text-foreground flex items-center justify-center transition-colors"
        aria-label="Jump to bottom"
        title="Jump to bottom"
      >
        <span className="text-lg leading-none">↓</span>
      </button>
    </div>
  );
}

function SidePanel({
  objective,
  dimension,
  toolCalls,
  onSubmitScore,
  submitting,
}: {
  objective: NonNullable<Objective>;
  dimension: Dimension;
  toolCalls: QueueToolCall[];
  onSubmitScore: (rawScore: number) => void;
  submitting: boolean;
}) {
  const [active, setActive] = useState<PanelKey | null>("rubric");
  const hasObjective = true;
  const hasRubric = true;
  const hasTools = toolCalls.length > 0;

  // Reserve real estate on the right when the panel is open so the page
  // content reflows next to the sidebar instead of being covered by it.
  useEffect(() => {
    if (active === null) return;
    const previous = document.body.style.paddingRight;
    const previousTransition = document.body.style.transition;
    document.body.style.transition = "padding-right 150ms ease";
    document.body.style.paddingRight = `${SIDEBAR_WIDTH_PX}px`;
    return () => {
      document.body.style.paddingRight = previous;
      document.body.style.transition = previousTransition;
    };
  }, [active]);

  const TabButton = ({
    panelKey,
    label,
  }: {
    panelKey: PanelKey;
    label: ReactNode;
  }) => (
    <button
      type="button"
      onClick={() => setActive(panelKey)}
      className={`px-3 py-1 rounded-md text-sm transition-colors ${active === panelKey ? "bg-secondary text-foreground font-medium" : "text-muted-foreground hover:text-foreground"}`}
    >
      {label}
    </button>
  );

  return (
    <>
      <div className="fixed bottom-4 right-4 z-40 flex flex-col items-end gap-2">
        {hasRubric ? (
          <button
            type="button"
            onClick={() =>
              setActive((prev) => (prev === "rubric" ? null : "rubric"))
            }
            className={`px-4 py-2 rounded-md border text-sm font-medium shadow-lg transition-colors ${active === "rubric" ? "bg-primary text-primary-foreground border-primary" : "bg-background border-border hover:bg-secondary"}`}
          >
            Rubric
          </button>
        ) : null}
        {hasObjective ? (
          <button
            type="button"
            onClick={() =>
              setActive((prev) => (prev === "objective" ? null : "objective"))
            }
            className={`px-4 py-2 rounded-md border text-sm font-medium shadow-lg transition-colors ${active === "objective" ? "bg-primary text-primary-foreground border-primary" : "bg-background border-border hover:bg-secondary"}`}
          >
            Objective
          </button>
        ) : null}
        {hasTools ? (
          <button
            type="button"
            onClick={() =>
              setActive((prev) => (prev === "tools" ? null : "tools"))
            }
            className={`px-4 py-2 rounded-md border text-sm font-medium shadow-lg transition-colors ${active === "tools" ? "bg-primary text-primary-foreground border-primary" : "bg-background border-border hover:bg-secondary"}`}
          >
            Tool calls ({toolCalls.length})
          </button>
        ) : null}
      </div>
      {active !== null ? (
        <div
          className="fixed top-0 right-0 bottom-0 z-50 border-l border-border bg-background shadow-2xl flex flex-col"
          style={{ width: `${SIDEBAR_WIDTH_PX}px` }}
        >
          <div className="px-4 py-3 border-b border-border flex items-center gap-2">
            <div className="flex-1 flex items-center gap-1 flex-wrap">
              {hasRubric ? (
                <TabButton panelKey="rubric" label="Rubric" />
              ) : null}
              {hasObjective ? (
                <TabButton panelKey="objective" label="Objective" />
              ) : null}
              {hasTools ? (
                <TabButton
                  panelKey="tools"
                  label={
                    <>
                      Tool calls{" "}
                      <span className="text-muted-foreground font-normal">
                        · {toolCalls.length}
                      </span>
                    </>
                  }
                />
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => setActive(null)}
              className="text-muted-foreground hover:text-foreground text-lg leading-none px-1"
              aria-label="Close panel"
            >
              ×
            </button>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-4">
            {active === "rubric" ? (
              <RubricPanel
                dimension={dimension}
                onSelect={onSubmitScore}
                submitting={submitting}
              />
            ) : null}
            {active === "objective" && objective ? (
              <ObjectivePanel objective={objective} />
            ) : null}
            {active === "tools" ? <ToolCallList toolCalls={toolCalls} /> : null}
          </div>
        </div>
      ) : null}
    </>
  );
}

export function ScoreSessionView({
  rubricId,
  dimensionId,
  request,
  navigate,
}: {
  rubricId: string;
  dimensionId: string;
  request: ServerRequest;
  navigate: (href: string) => void;
}) {
  const [rubric, setRubric] = useState<Rubric | null>(null);
  const [dimension, setDimension] = useState<Dimension | null>(null);
  const [item, setItem] = useState<QueueItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      request<RubricsResponse>("/api/human-scoring/rubrics"),
      request<NextResponse>(
        `/api/human-scoring/next?rubric_id=${encodeURIComponent(rubricId)}&dimension_id=${encodeURIComponent(dimensionId)}`,
      ),
    ])
      .then(([rubrics, next]) => {
        if (cancelled) return;
        const matchedRubric =
          rubrics.rubrics.find((r) => r.rubricId === rubricId) ?? null;
        const matchedDim =
          matchedRubric?.dimensions.find((d) => d.id === dimensionId) ?? null;
        setRubric(matchedRubric);
        setDimension(matchedDim);
        setItem(next.item);
        setError(null);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [request, rubricId, dimensionId]);

  const submitScore = useCallback(
    async (rawScore: number) => {
      if (!item || submitting) return;
      setSubmitting(true);
      setError(null);
      try {
        const response = await request<ScoreResponse>(
          "/api/human-scoring/scores",
          jsonBody("POST", {
            scenario_run_id: item.scenarioRunId,
            rubric_id: rubricId,
            dimension_id: dimensionId,
            raw_score: rawScore,
          }),
        );
        setItem(response.next);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSubmitting(false);
      }
    },
    [request, item, submitting, rubricId, dimensionId],
  );

  useEffect(() => {
    if (!item || submitting || !dimension) return;
    const entries = scaleEntries(dimension.scale);
    const allowed = new Set(entries.map((entry) => entry.value));
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        /input|textarea|select/i.test(target.tagName)
      ) {
        return;
      }
      const num = Number(event.key);
      if (!Number.isFinite(num) || !allowed.has(num)) return;
      event.preventDefault();
      void submitScore(num);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [item, dimension, submitting, submitScore]);

  if (loading) {
    return <PageHeaderSkeleton withMeta />;
  }
  if (error && !item) {
    return <ErrorBanner message={error} />;
  }
  if (!rubric || !dimension) {
    return (
      <>
        <ErrorBanner message="Unknown rubric or dimension." />
        <Button variant="secondary" onClick={() => navigate("/score")}>
          Back to scoring
        </Button>
      </>
    );
  }

  if (!item) {
    return (
      <>
        <PageHeader
          eyebrow={`${rubric.rubricName} · ${dimension.name}`}
          title="Queue empty"
          meta="No more unscored chats for this dimension."
        />
        <div className="flex gap-2">
          <Button onClick={() => navigate("/score")}>Back to scoring</Button>
        </div>
      </>
    );
  }

  const detail = buildScenarioDetail(item);
  const entries = scaleEntries(dimension.scale);
  const judgeContext =
    item.judgeDimensionRawScore !== null &&
    item.judgeDimensionRawScore !== undefined
      ? `Judge scored this dimension ${item.judgeDimensionRawScore}` +
        (item.overallScore !== null && item.overallScore !== undefined
          ? `  ·  overall ${item.overallScore.toFixed(2)}`
          : "")
      : null;
  const objective = buildObjective(item);

  return (
    <>
      <PageHeader
        eyebrow={`${rubric.rubricName} · ${dimension.name}`}
        title={item.scenarioName}
        meta={
          <span>
            <span className="font-mono">{item.scenarioId}</span>
            {" · run "}
            <a href={`/runs/${encodeURIComponent(item.runId)}`}>
              {item.runId.slice(0, 8)}
            </a>
            {" · "}
            <a
              href={`/runs/${encodeURIComponent(item.runId)}/scenarios/${item.ordinal}`}
            >
              detail
            </a>
            {" · "}
            <a
              href="/score"
              onClick={(event) => {
                event.preventDefault();
                navigate("/score");
              }}
            >
              back
            </a>
          </span>
        }
      />
      <div className="text-xs text-muted-foreground mb-3 font-mono">
        <strong className="text-foreground text-base">{item.remaining}</strong>{" "}
        remaining
      </div>
      {judgeContext ? (
        <Card className="p-3 mb-4 border-l-4 border-l-muted-foreground/50">
          <div className="text-xs text-foreground">{judgeContext}</div>
        </Card>
      ) : null}
      {error ? <ErrorBanner message={error} /> : null}
      <Card className="p-4 mb-4">
        <ConversationView detail={detail} />
      </Card>
      <div className="space-y-2 pb-24">
        {entries.map((entry) => (
          <button
            key={entry.value}
            type="button"
            disabled={submitting}
            onClick={() => void submitScore(entry.value)}
            className="w-full grid grid-cols-[56px_1fr] gap-3 items-center px-4 py-3 rounded-md border border-border bg-secondary/40 hover:border-primary hover:bg-secondary text-left disabled:opacity-60 disabled:cursor-progress transition-colors"
          >
            <span className="text-2xl font-bold font-mono text-primary text-center">
              {entry.value}
            </span>
            <span className="text-sm whitespace-pre-wrap">{entry.label}</span>
          </button>
        ))}
      </div>
      <ScrollNav />
      <SidePanel
        objective={objective}
        dimension={dimension}
        toolCalls={item.toolCalls ?? []}
        onSubmitScore={(rawScore) => void submitScore(rawScore)}
        submitting={submitting}
      />
    </>
  );
}

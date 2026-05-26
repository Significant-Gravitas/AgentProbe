import {
  CheckCircle2,
  ListOrdered,
  Network,
  Sparkles,
  Target,
  XCircle,
} from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../lib/utils.ts";
import type {
  DedupMetricScore,
  DemotionMetricScore,
  ProcedureMetricScore,
  RetrievalMetricScore,
  ScenarioDetail,
} from "../types.ts";

interface Props {
  detail: ScenarioDetail;
}

type AnyMetric =
  | RetrievalMetricScore
  | DemotionMetricScore
  | ProcedureMetricScore
  | DedupMetricScore;

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "n/a";
  return value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

function pct(value: number): string {
  if (!Number.isFinite(value)) return "n/a";
  return `${Math.round(value * 100)}%`;
}

function MetricBar({ value }: { value: number }) {
  const clamped = Math.max(0, Math.min(1, value));
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div
        className="h-full rounded-full bg-foreground/70"
        style={{ width: `${clamped * 100}%` }}
      />
    </div>
  );
}

function PassPill({ passed }: { passed: boolean }) {
  return passed ? (
    <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
      <CheckCircle2 size={11} strokeWidth={2.5} />
      Pass
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-full border border-rose-500/40 bg-rose-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-rose-700 dark:text-rose-400">
      <XCircle size={11} strokeWidth={2.5} />
      Fail
    </span>
  );
}

function SectionLabel({
  children,
  count,
}: {
  children: ReactNode;
  count?: number | string;
}) {
  return (
    <div className="flex items-center gap-2">
      <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        {children}
      </div>
      {count != null && (
        <div className="font-mono text-[10px] text-muted-foreground/70">
          {count}
        </div>
      )}
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

function MetricCard({ m }: { m: AnyMetric }) {
  return (
    <div className="flex items-center gap-3 rounded-md border border-border bg-card/40 px-3 py-2">
      <div className="min-w-[150px] font-mono text-[11px] text-foreground">
        {m.metric}
      </div>
      <div className="flex-1">
        <MetricBar value={m.value} />
      </div>
      <div className="min-w-[48px] text-right font-mono text-[11px] text-foreground">
        {formatNumber(m.value)}
      </div>
      <div className="min-w-[36px] text-right font-mono text-[10px] text-muted-foreground">
        ×{formatNumber(m.weight)}
      </div>
    </div>
  );
}

function ScorerHeader({
  icon,
  title,
  subtitle,
  weightedScore,
  passThreshold,
  passed,
  source,
}: {
  icon: ReactNode;
  title: string;
  subtitle?: string;
  weightedScore: number;
  passThreshold: number;
  passed: boolean;
  source: string;
}) {
  return (
    <header className="flex items-center justify-between gap-4 rounded-md border border-border bg-muted/30 px-3 py-2">
      <div className="flex items-center gap-2.5">
        <div className="flex h-7 w-7 items-center justify-center rounded-md border border-border bg-card text-muted-foreground">
          {icon}
        </div>
        <div className="flex flex-col">
          <div className="text-sm font-semibold text-foreground">{title}</div>
          {subtitle && (
            <div className="text-[11px] text-muted-foreground">{subtitle}</div>
          )}
        </div>
      </div>
      <div className="flex items-center gap-3 text-[11px]">
        <div className="flex flex-col items-end leading-tight">
          <div className="font-mono text-foreground">
            {pct(weightedScore)}
            <span className="text-muted-foreground">
              {" "}
              / {pct(passThreshold)}
            </span>
          </div>
          <div className="text-[10px] text-muted-foreground">
            source: {source}
          </div>
        </div>
        <PassPill passed={passed} />
      </div>
    </header>
  );
}

function aggregate(metrics: AnyMetric[]) {
  if (metrics.length === 0) {
    return {
      weightedScore: 0,
      passThreshold: 0,
      passed: false,
      source: "missing",
    };
  }
  const first = metrics[0];
  return {
    weightedScore: first.weighted_score,
    passThreshold: first.pass_threshold,
    passed: first.passed,
    source: first.source,
  };
}

function RetrievalSection({ metrics }: { metrics: RetrievalMetricScore[] }) {
  if (metrics.length === 0) return null;
  const agg = aggregate(metrics);
  const first = metrics[0];
  return (
    <section className="flex flex-col gap-2">
      <ScorerHeader
        icon={<Target size={14} strokeWidth={2.25} />}
        title="Retrieval ranking"
        subtitle={`k=${first?.k ?? "n/a"}, ${first?.hit_count ?? 0}/${first?.total_relevant ?? 0} hits, ${first?.forbidden_hits ?? 0} forbidden`}
        weightedScore={agg.weightedScore}
        passThreshold={agg.passThreshold}
        passed={agg.passed}
        source={agg.source}
      />
      <div className="flex flex-col gap-1.5">
        {metrics.map((m, i) => (
          <MetricCard key={`${m.metric}-${i}`} m={m} />
        ))}
      </div>
    </section>
  );
}

function DemotionSection({ metrics }: { metrics: DemotionMetricScore[] }) {
  if (metrics.length === 0) return null;
  const agg = aggregate(metrics);
  const first = metrics[0];
  const subtitleBits: string[] = [];
  if (first) {
    subtitleBits.push(
      `timestamp violations: ${first.timestamp_violation_count}`,
    );
    if (first.cascade_bounded === true) subtitleBits.push("cascade: bounded");
    else if (first.cascade_bounded === false)
      subtitleBits.push("cascade: RUNAWAY");
  }
  return (
    <section className="flex flex-col gap-2">
      <ScorerHeader
        icon={<Network size={14} strokeWidth={2.25} />}
        title="Demotion correctness"
        subtitle={subtitleBits.join(" · ")}
        weightedScore={agg.weightedScore}
        passThreshold={agg.passThreshold}
        passed={agg.passed}
        source={agg.source}
      />
      <div className="flex flex-col gap-1.5">
        {metrics.map((m, i) => (
          <MetricCard key={`${m.metric}-${i}`} m={m} />
        ))}
      </div>
    </section>
  );
}

function ProcedureSection({ metrics }: { metrics: ProcedureMetricScore[] }) {
  if (metrics.length === 0) return null;
  const agg = aggregate(metrics);
  const first = metrics[0];
  const predicted = Array.isArray(first?.predicted)
    ? (first.predicted as string[])
    : [];
  const golden = Array.isArray(first?.golden) ? (first.golden as string[]) : [];
  return (
    <section className="flex flex-col gap-2">
      <ScorerHeader
        icon={<ListOrdered size={14} strokeWidth={2.25} />}
        title="Procedure extraction"
        subtitle={`predicted ${predicted.length} steps · golden ${golden.length} steps`}
        weightedScore={agg.weightedScore}
        passThreshold={agg.passThreshold}
        passed={agg.passed}
        source={agg.source}
      />
      <div className="flex flex-col gap-1.5">
        {metrics.map((m, i) => (
          <MetricCard key={`${m.metric}-${i}`} m={m} />
        ))}
      </div>
      {(predicted.length > 0 || golden.length > 0) && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <StepList title="Predicted" items={predicted} />
          <StepList title="Golden" items={golden} />
        </div>
      )}
    </section>
  );
}

function StepList({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="rounded-md border border-border bg-background p-2.5">
      <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        {title}
      </div>
      {items.length === 0 ? (
        <div className="text-[11px] text-muted-foreground">(empty)</div>
      ) : (
        <ol className="flex flex-col gap-1 font-mono text-[11px] text-foreground">
          {items.map((step, i) => (
            <li key={`${title}-${i}`} className="flex gap-2">
              <span className="text-muted-foreground">{i + 1}.</span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function DedupSection({ metrics }: { metrics: DedupMetricScore[] }) {
  if (metrics.length === 0) return null;
  const agg = aggregate(metrics);
  const first = metrics[0];
  const predicted = Array.isArray(first?.predicted)
    ? (first.predicted as string[][])
    : [];
  const golden = Array.isArray(first?.golden)
    ? (first.golden as string[][])
    : [];
  return (
    <section className="flex flex-col gap-2">
      <ScorerHeader
        icon={<Sparkles size={14} strokeWidth={2.25} />}
        title="Deduplication"
        subtitle={`items: ${first?.item_count ?? 0} · predicted ${predicted.length} clusters · golden ${golden.length} clusters`}
        weightedScore={agg.weightedScore}
        passThreshold={agg.passThreshold}
        passed={agg.passed}
        source={agg.source}
      />
      <div className="flex flex-col gap-1.5">
        {metrics.map((m, i) => (
          <MetricCard key={`${m.metric}-${i}`} m={m} />
        ))}
      </div>
      {(predicted.length > 0 || golden.length > 0) && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <ClusterList title="Predicted" clusters={predicted} />
          <ClusterList title="Golden" clusters={golden} />
        </div>
      )}
    </section>
  );
}

function ClusterList({
  title,
  clusters,
}: {
  title: string;
  clusters: string[][];
}) {
  return (
    <div className="rounded-md border border-border bg-background p-2.5">
      <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        {title}
      </div>
      {clusters.length === 0 ? (
        <div className="text-[11px] text-muted-foreground">(empty)</div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {clusters.map((cluster, i) => (
            <div
              key={`${title}-${i}`}
              className={cn(
                "rounded border border-border bg-muted/30 px-2 py-1 font-mono text-[11px] leading-relaxed text-foreground",
              )}
            >
              {cluster.join(", ")}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function EvalScoresView({ detail }: Props) {
  const retrieval = detail.retrieval_scores ?? [];
  const demotion = detail.demotion_scores ?? [];
  const procedure = detail.procedure_scores ?? [];
  const dedup = detail.dedup_scores ?? [];
  const totalCount =
    retrieval.length + demotion.length + procedure.length + dedup.length;

  if (totalCount === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border px-4 py-12 text-center">
        <Target size={18} strokeWidth={2} className="text-muted-foreground" />
        <div className="text-sm font-medium text-foreground">
          No quantitative eval scores
        </div>
        <p className="max-w-md text-[12px] text-muted-foreground">
          This scenario didn't declare a retrieval, demotion, procedure, or
          dedup block. Add one to its YAML to get IR-style metrics here.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <SectionLabel count={totalCount}>Eval scores</SectionLabel>
      <RetrievalSection metrics={retrieval} />
      <DemotionSection metrics={demotion} />
      <ProcedureSection metrics={procedure} />
      <DedupSection metrics={dedup} />
    </div>
  );
}

export function hasEvalScores(detail: ScenarioDetail): boolean {
  return (
    (detail.retrieval_scores?.length ?? 0) > 0 ||
    (detail.demotion_scores?.length ?? 0) > 0 ||
    (detail.procedure_scores?.length ?? 0) > 0 ||
    (detail.dedup_scores?.length ?? 0) > 0
  );
}

import { scorePct } from "../helpers.ts";
import type { DimensionScore, ScenarioDetail } from "../types.ts";

interface Props {
  detail: ScenarioDetail;
}

function DimensionCard({ d }: { d: DimensionScore }) {
  const pct = scorePct(d.normalized_score);
  const scoreLabel =
    d.raw_score != null
      ? `${d.raw_score}${d.scale_points != null ? `/${d.scale_points}` : ""}`
      : "n/a";

  return (
    <div className="dimension">
      <div className="dim-header">
        <div>
          <div className="dim-name">{d.dimension_name}</div>
          <div className="dim-id">{d.dimension_id}</div>
        </div>
        <div className="dim-score-block">
          <div className="dim-score">{scoreLabel}</div>
          {d.weight != null && (
            <div className="dim-weight">Weight {d.weight}</div>
          )}
        </div>
      </div>
      <div className="dim-bar">
        <div className="dim-fill" style={{ width: `${pct}%` }} />
      </div>
      {d.reasoning && <div className="dim-reasoning">{d.reasoning}</div>}
      {(d.evidence ?? []).length > 0 && (
        <div className="dim-evidence">
          {d.evidence?.map((e, i) => (
            <div key={i} className="evidence-item">
              {e}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function RubricView({ detail }: Props) {
  const dims = detail.judge_dimension_scores ?? [];
  const notes = detail.judge?.overall_notes;
  const judgeOutput = detail.judge?.output;

  return (
    <div>
      {notes && (
        <div className="overall-notes">
          <div className="section-label">Overall Notes</div>
          <div className="notes-text">{notes}</div>
        </div>
      )}
      {dims.length > 0 ? (
        dims.map((d, i) => <DimensionCard key={i} d={d} />)
      ) : (
        <div className="no-data">No rubric dimensions recorded.</div>
      )}
      {judgeOutput && (
        <details className="judge-raw">
          <summary>Raw Judge Output</summary>
          <pre>{JSON.stringify(judgeOutput, null, 2)}</pre>
        </details>
      )}
    </div>
  );
}

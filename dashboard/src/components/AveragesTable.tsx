import { Fragment, useState } from "react";
import { scorePct } from "../helpers.ts";
import type { AverageScore, DimensionAverage } from "../types.ts";

interface Props {
  averages: AverageScore[];
  onSelectRun: (ordinal: number) => void;
}

function DimBar({ d }: { d: DimensionAverage }) {
  const pct = scorePct(d.avg);
  return (
    <div className="avg-dim">
      <div className="avg-dim-header">
        <span className="avg-dim-name">{d.dimension_name}</span>
        <span className="avg-dim-score">{d.avg.toFixed(2)}</span>
      </div>
      <div className="dim-bar">
        <div className="dim-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="avg-dim-range">
        {d.min.toFixed(2)} &ndash; {d.max.toFixed(2)} ({d.n} runs)
      </div>
    </div>
  );
}

function ExpandedDetail({
  avg,
  onSelectRun,
}: {
  avg: AverageScore;
  onSelectRun: (ordinal: number) => void;
}) {
  const failureModes = Object.entries(avg.failure_modes);
  const passRate =
    avg.n > 0 ? ((avg.pass_count / avg.n) * 100).toFixed(0) : "0";

  return (
    <tr>
      <td colSpan={6} style={{ padding: 0 }}>
        <div className="avg-detail">
          <div className="avg-detail-header">
            <div className="avg-detail-title">
              {avg.scenario_name ?? avg.base_id}
            </div>
            <div className="avg-detail-subtitle">{avg.base_id}</div>
          </div>

          <div className="avg-detail-stats">
            <div className="avg-stat">
              <div className="avg-stat-value" style={{ color: "var(--green)" }}>
                {passRate}%
              </div>
              <div className="avg-stat-label">Pass Rate</div>
            </div>
            <div className="avg-stat">
              <div className="avg-stat-value">
                {avg.pass_count}/{avg.n}
              </div>
              <div className="avg-stat-label">Pass/Total</div>
            </div>
            <div className="avg-stat">
              <div className="avg-stat-value">{avg.avg.toFixed(3)}</div>
              <div className="avg-stat-label">Mean Score</div>
            </div>
            <div className="avg-stat">
              <div className="avg-stat-value">{avg.spread.toFixed(3)}</div>
              <div className="avg-stat-label">Spread</div>
            </div>
          </div>

          {failureModes.length > 0 && (
            <div className="avg-section">
              <div className="section-label">Failure Modes</div>
              <div className="avg-failure-modes">
                {failureModes.map(([mode, count]) => (
                  <span key={mode} className="avg-failure-pill">
                    {mode}{" "}
                    <span className="avg-failure-count">&times;{count}</span>
                  </span>
                ))}
              </div>
            </div>
          )}

          {avg.dimensions.length > 0 && (
            <div className="avg-section">
              <div className="section-label">Dimension Averages</div>
              <div className="avg-dims-grid">
                {avg.dimensions.map((d) => (
                  <DimBar key={d.dimension_id} d={d} />
                ))}
              </div>
            </div>
          )}

          {avg.judge_notes.length > 0 && (
            <div className="avg-section">
              <div className="section-label">
                Judge Notes ({avg.judge_notes.length})
              </div>
              <div className="avg-notes">
                {avg.judge_notes.map((note, i) => (
                  <div key={i} className="avg-note">
                    <span className="avg-note-num">#{i + 1}</span>
                    {note}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="avg-section">
            <div className="section-label">Individual Runs</div>
            <div className="avg-runs">
              {avg.ordinals.map((ord, i) => (
                <button
                  type="button"
                  key={ord}
                  className="avg-run-btn"
                  onClick={() => onSelectRun(ord)}
                >
                  Run #{i + 1}
                </button>
              ))}
            </div>
          </div>
        </div>
      </td>
    </tr>
  );
}

export function AveragesTable({ averages, onSelectRun }: Props) {
  const [expanded, setExpanded] = useState<string | null>(null);

  if (averages.length === 0) return null;

  return (
    <>
      <div className="section-title">
        Averages (across repeats){" "}
        <span style={{ color: "var(--muted)", fontWeight: 400, fontSize: 12 }}>
          (click to expand)
        </span>
      </div>
      <table>
        <thead>
          <tr>
            <th>Scenario</th>
            <th style={{ textAlign: "right" }}>Avg</th>
            <th style={{ textAlign: "right" }}>Min</th>
            <th style={{ textAlign: "right" }}>Max</th>
            <th style={{ textAlign: "right" }}>Spread</th>
            <th style={{ textAlign: "right" }}>N</th>
          </tr>
        </thead>
        <tbody>
          {averages.map((a) => (
            <Fragment key={a.base_id}>
              <tr
                className={`${a.avg >= 0.7 ? "avg-pass" : "avg-fail"} clickable-row`}
                onClick={() =>
                  setExpanded(expanded === a.base_id ? null : a.base_id)
                }
              >
                <td>
                  {a.base_id}
                  <span
                    className="avg-expand-icon"
                    style={{
                      marginLeft: 6,
                      display: "inline-block",
                      transform:
                        expanded === a.base_id ? "rotate(90deg)" : "none",
                      transition: "transform .15s",
                    }}
                  >
                    &#9656;
                  </span>
                </td>
                <td style={{ textAlign: "right" }}>{a.avg.toFixed(3)}</td>
                <td style={{ textAlign: "right" }}>{a.min.toFixed(2)}</td>
                <td style={{ textAlign: "right" }}>{a.max.toFixed(2)}</td>
                <td style={{ textAlign: "right" }}>{a.spread.toFixed(3)}</td>
                <td style={{ textAlign: "right" }}>{a.n}</td>
              </tr>
              {expanded === a.base_id && (
                <ExpandedDetail avg={a} onSelectRun={onSelectRun} />
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </>
  );
}

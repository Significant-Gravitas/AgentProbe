import { useEffect, useRef, useState } from "react";
import type { DashboardData, ScenarioState } from "../types.ts";

interface Props {
  data: DashboardData;
  onSelect: (ordinal: number) => void;
}

const STATUS_LABELS: Record<string, string> = {
  pending: "PENDING",
  running: "RUNNING",
  pass: "PASS",
  fail: "FAIL",
  error: "ERROR",
};

function Duration({ scenario }: { scenario: ScenarioState }) {
  const [now, setNow] = useState(Date.now());
  const intervalRef = useRef<ReturnType<typeof setInterval> | undefined>(
    undefined,
  );

  useEffect(() => {
    if (scenario.status === "running" && scenario.started_at != null) {
      intervalRef.current = setInterval(() => setNow(Date.now()), 1000);
      return () => clearInterval(intervalRef.current);
    }
    clearInterval(intervalRef.current);
  }, [scenario.status, scenario.started_at]);

  if (scenario.started_at == null) return <>-</>;
  if (scenario.finished_at != null) {
    return <>{(scenario.finished_at - scenario.started_at).toFixed(1)}s</>;
  }
  const elapsed = now / 1000 - scenario.started_at;
  return <>{elapsed > 0 ? `${elapsed.toFixed(0)}s` : "-"}</>;
}

export function ScenarioTable({ data, onSelect }: Props) {
  return (
    <>
      <div className="section-title">
        Scenarios{" "}
        <span style={{ color: "var(--muted)", fontWeight: 400, fontSize: 12 }}>
          (click completed rows to inspect)
        </span>
      </div>
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Name</th>
            <th>Status</th>
            <th style={{ textAlign: "right" }}>Score</th>
            <th style={{ textAlign: "right" }}>Duration</th>
            <th>Error</th>
          </tr>
        </thead>
        <tbody>
          {data.scenarios.map((s, i) => {
            const hasDetail = i in data.details;
            return (
              <tr
                key={`${s.scenario_id}-${i}`}
                className={`status-${s.status}${hasDetail ? " clickable-row" : ""}`}
                onClick={hasDetail ? () => onSelect(i) : undefined}
              >
                <td className="id-cell">{s.scenario_id}</td>
                <td>{s.scenario_name ?? ""}</td>
                <td className="status-badge">
                  <span>
                    {STATUS_LABELS[s.status] ?? s.status.toUpperCase()}
                  </span>
                </td>
                <td className="score-cell">
                  {s.score != null ? s.score.toFixed(2) : "-"}
                </td>
                <td className="duration-cell">
                  <Duration scenario={s} />
                </td>
                <td>
                  {s.error && (
                    <span className="error-text" title={s.error}>
                      {s.error.slice(0, 60)}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

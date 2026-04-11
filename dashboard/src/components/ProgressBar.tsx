import type { DashboardData } from "../types.ts";

interface Props {
  data: DashboardData;
}

export function ProgressBar({ data }: Props) {
  const total = data.total || 1;
  const passPct = (data.passed / total) * 100;
  const failPct = (data.failed / total) * 100;
  const runPct = (data.running / total) * 100;

  return (
    <div className="progress-bar" style={{ display: "flex" }}>
      <div className="progress-fill progress-pass" style={{ width: `${passPct}%` }} />
      <div className="progress-fill progress-fail" style={{ width: `${failPct}%` }} />
      <div className="progress-fill progress-running" style={{ width: `${runPct}%` }} />
    </div>
  );
}

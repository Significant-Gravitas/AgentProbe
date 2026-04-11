import type { DashboardData } from "../types.ts";
import { useElapsed, formatElapsed } from "../hooks/useElapsed.ts";

interface Props {
  data: DashboardData;
}

function Stat({
  value,
  label,
  color,
}: { value: string; label: string; color: string }) {
  return (
    <div className="stat">
      <div className="stat-value" style={{ color }}>
        {value}
      </div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

export function StatsBar({ data }: Props) {
  const elapsed = useElapsed(data.elapsed, data.all_done);
  const pct = data.total > 0 ? Math.round((data.done / data.total) * 100) : 0;

  return (
    <div className="stats">
      <Stat
        value={`${data.done}/${data.total}`}
        label="Completed"
        color="var(--text)"
      />
      <Stat value={`${data.passed}`} label="Passed" color="var(--green)" />
      <Stat value={`${data.failed}`} label="Failed" color="var(--red)" />
      <Stat value={`${data.errored}`} label="Errors" color="var(--amber)" />
      <Stat value={`${data.running}`} label="Running" color="var(--blue)" />
      <Stat
        value={formatElapsed(elapsed)}
        label="Elapsed"
        color="var(--muted)"
      />
      <Stat value={`${pct}%`} label="Progress" color="var(--indigo)" />
    </div>
  );
}

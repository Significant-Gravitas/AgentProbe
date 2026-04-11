import { useState } from "react";
import { useDashboard } from "./hooks/useDashboard.ts";
import { StatsBar } from "./components/StatsBar.tsx";
import { ProgressBar } from "./components/ProgressBar.tsx";
import { ScenarioTable } from "./components/ScenarioTable.tsx";
import { AveragesTable } from "./components/AveragesTable.tsx";
import { DetailPanel } from "./components/DetailPanel.tsx";

export function App() {
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
    selectedOrdinal != null ? data.details[selectedOrdinal] ?? null : null;

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
      <AveragesTable averages={data.averages} onSelectRun={setSelectedOrdinal} />

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

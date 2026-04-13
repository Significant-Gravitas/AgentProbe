import { useEffect, useRef, useState } from "react";
import type { DashboardData } from "../types.ts";

const POLL_INTERVAL = 2000;

export function useDashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const allDoneRef = useRef(false);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval>;
    let cancelled = false;

    async function poll() {
      try {
        const res = await fetch("/api/state");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json: DashboardData = await res.json();
        if (cancelled) return;
        setData(json);
        setError(null);
        allDoneRef.current = json.all_done;
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Unknown error");
      }
    }

    poll();
    timer = setInterval(() => {
      if (!allDoneRef.current) poll();
    }, POLL_INTERVAL);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return { data, error };
}

import { useEffect, useState } from "react";

export function useElapsed(serverElapsed: number, allDone: boolean) {
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    if (allDone) return;
    const start = performance.now();
    const baseElapsed = serverElapsed;
    const id = setInterval(() => {
      setOffset((performance.now() - start) / 1000);
    }, 500);
    return () => {
      clearInterval(id);
      setOffset(0);
    };
  }, [serverElapsed, allDone]);

  if (allDone) return serverElapsed;
  return serverElapsed + offset;
}

export function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}m ${s}s`;
}

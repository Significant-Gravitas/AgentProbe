import type { JsonValue } from "../../../shared/types/contracts.ts";

export type RunEventKind =
  | "snapshot"
  | "suite_started"
  | "run_started"
  | "run_progress"
  | "run_finished"
  | "run_cancelled"
  | "run_failed"
  | "run_error"
  | "scenario_started"
  | "scenario_finished"
  | "scenario_error"
  | "log";

export const TERMINAL_EVENT_KINDS: ReadonlySet<RunEventKind> = new Set([
  "run_finished",
  "run_cancelled",
  "run_failed",
]);

export function isTerminalEvent(event: RunEvent): boolean {
  return TERMINAL_EVENT_KINDS.has(event.kind);
}

export type RunEvent = {
  id: number;
  runId: string;
  kind: RunEventKind;
  payload: JsonValue;
  createdAt: string;
};

export function formatSseEvent(event: RunEvent): string {
  const data = JSON.stringify({
    id: event.id,
    run_id: event.runId,
    kind: event.kind,
    payload: event.payload,
    created_at: event.createdAt,
  });
  return `id: ${event.id}\nevent: ${event.kind}\ndata: ${data}\n\n`;
}

export function formatSseKeepalive(): string {
  return `: keepalive ${new Date().toISOString()}\n\n`;
}

export function formatSseRetry(retryMs: number): string {
  return `retry: ${Math.max(0, Math.floor(retryMs))}\n\n`;
}

import type { JsonValue } from "../../../shared/types/contracts.ts";

export type RunEventKind =
  | "snapshot"
  | "run_started"
  | "run_progress"
  | "run_finished"
  | "run_error"
  | "scenario_started"
  | "scenario_finished"
  | "log";

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

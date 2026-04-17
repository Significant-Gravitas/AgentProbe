import type { RunRecord } from "../../../shared/types/contracts.ts";
import type { ServerContext } from "../app-server.ts";
import { errorResponse } from "../http-helpers.ts";
import {
  formatSseEvent,
  formatSseKeepalive,
  type RunEvent,
} from "../streams/events.ts";

const KEEPALIVE_INTERVAL_MS = 15_000;

function snapshotPayloadForRun(run: RunRecord): RunEvent["payload"] {
  return {
    run_id: run.runId,
    status: run.status,
    passed: run.passed ?? null,
    exit_code: run.exitCode ?? null,
    started_at: run.startedAt,
    completed_at: run.completedAt ?? null,
    aggregate_counts: {
      scenario_total: run.aggregateCounts.scenarioTotal,
      scenario_passed_count: run.aggregateCounts.scenarioPassedCount,
      scenario_failed_count: run.aggregateCounts.scenarioFailedCount,
      scenario_errored_count: run.aggregateCounts.scenarioErroredCount,
    },
    scenarios: run.scenarios.map((scenario) => ({
      ordinal: scenario.ordinal,
      scenario_id: scenario.scenarioId,
      status: scenario.status,
      passed: scenario.passed ?? null,
      overall_score: scenario.overallScore ?? null,
    })),
  };
}

function parseLastEventId(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return undefined;
  }
  return parsed;
}

export async function handleRunSse(
  request: Request,
  context: ServerContext,
  params: { runId: string },
): Promise<Response> {
  const lastEventId = parseLastEventId(request.headers.get("last-event-id"));
  const { runId } = params;

  const historicalRun: RunRecord | undefined = context.config.dbUrl
    ? await context.repository.getRun(runId)
    : undefined;

  // Replay any buffered events (after last-event-id if provided).
  const replayEvents = context.streamHub.replay(runId, lastEventId);

  // If neither a buffered stream nor a historical run exist, treat as 404.
  if (!historicalRun && replayEvents.length === 0) {
    return errorResponse({
      status: 404,
      type: "NotFound",
      message: `Run \`${runId}\` was not found.`,
      requestId: context.requestId,
    });
  }

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | undefined;
  let keepalive: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const safeEnqueue = (chunk: string): void => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // controller may be closed; ignore
        }
      };
      const cleanup = (): void => {
        if (closed) {
          return;
        }
        closed = true;
        if (unsubscribe) {
          unsubscribe();
          unsubscribe = undefined;
        }
        if (keepalive) {
          clearInterval(keepalive);
          keepalive = undefined;
        }
      };
      const close = (): void => {
        cleanup();
        try {
          controller.close();
        } catch {
          // ignore
        }
      };

      if (replayEvents.length > 0) {
        for (const event of replayEvents) {
          safeEnqueue(formatSseEvent(event));
        }
        if (historicalRun && historicalRun.status !== "running") {
          queueMicrotask(close);
          return;
        }
      } else if (historicalRun) {
        const snapshot = context.streamHub.publish({
          runId,
          kind: "snapshot",
          payload: snapshotPayloadForRun(historicalRun),
        });
        safeEnqueue(formatSseEvent(snapshot));
        if (historicalRun.status !== "running") {
          queueMicrotask(close);
          return;
        }
      }

      unsubscribe = context.streamHub.subscribe(runId, (event) => {
        safeEnqueue(formatSseEvent(event));
      });

      keepalive = setInterval(() => {
        safeEnqueue(formatSseKeepalive());
      }, KEEPALIVE_INTERVAL_MS);

      if (request.signal) {
        request.signal.addEventListener("abort", () => {
          close();
        });
      }
    },
    cancel() {
      if (unsubscribe) {
        unsubscribe();
      }
      if (keepalive) {
        clearInterval(keepalive);
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
      connection: "keep-alive",
      "x-request-id": context.requestId,
    },
  });
}

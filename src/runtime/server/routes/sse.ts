import type { RunRecord } from "../../../shared/types/contracts.ts";
import type { ServerContext } from "../app-server.ts";
import { errorResponse } from "../http-helpers.ts";
import { METRIC_NAMES } from "../observability/index.ts";
import {
  formatSseEvent,
  formatSseKeepalive,
  formatSseRetry,
  isTerminalEvent,
  type RunEvent,
} from "../streams/events.ts";

export const SSE_KEEPALIVE_INTERVAL_MS = 15_000;
export const SSE_RECONNECT_RETRY_MS = 2_000;

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

function parseLastEventId(
  value: string | null | undefined,
): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return undefined;
  }
  return parsed;
}

function pickLastEventId(request: Request, url: URL): number | undefined {
  const headerValue =
    request.headers.get("last-event-id") ??
    request.headers.get("Last-Event-ID");
  const queryValue = url.searchParams.get("last_event_id");
  return parseLastEventId(headerValue) ?? parseLastEventId(queryValue);
}

function terminalEventForHistorical(
  run: RunRecord,
): RunEvent["kind"] | undefined {
  if (run.status === "running") return undefined;
  if (run.status === "cancelled") return "run_cancelled";
  if (run.status === "errored" || run.status === "failed") return "run_failed";
  return "run_finished";
}

export async function handleRunSse(
  request: Request,
  context: ServerContext,
  params: { runId: string },
): Promise<Response> {
  const url = new URL(request.url);
  const lastEventId = pickLastEventId(request, url);
  const { runId } = params;

  const historicalRun: RunRecord | undefined = context.config.dbUrl
    ? await context.repository.getRun(runId)
    : undefined;

  const replayEvents = context.streamHub.replay(runId, lastEventId);

  if (!historicalRun && replayEvents.length === 0) {
    return errorResponse({
      status: 404,
      type: "NotFound",
      message: `Run \`${runId}\` was not found.`,
      requestId: context.requestId,
    });
  }

  const encoder = new TextEncoder();
  const metrics = context.observability.metrics;
  let unsubscribe: (() => void) | undefined;
  let keepalive: ReturnType<typeof setInterval> | undefined;
  let teardown: (() => void) | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let connectionCounted = false;
      let terminalSent = false;
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
        if (connectionCounted) {
          metrics.adjustGauge(METRIC_NAMES.sseConnections, -1);
          connectionCounted = false;
        }
      };
      teardown = cleanup;
      const close = (): void => {
        cleanup();
        try {
          controller.close();
        } catch {
          // ignore
        }
      };

      metrics.adjustGauge(METRIC_NAMES.sseConnections, 1);
      connectionCounted = true;

      // Always advise reconnect retry interval to the browser.
      safeEnqueue(formatSseRetry(SSE_RECONNECT_RETRY_MS));

      const dispatchEvent = (event: RunEvent): void => {
        safeEnqueue(formatSseEvent(event));
        if (isTerminalEvent(event) && !terminalSent) {
          terminalSent = true;
          queueMicrotask(close);
        }
      };

      if (replayEvents.length > 0) {
        for (const event of replayEvents) {
          dispatchEvent(event);
        }
        if (!terminalSent && historicalRun) {
          const terminalKind = terminalEventForHistorical(historicalRun);
          if (terminalKind) {
            const terminalEvent = context.streamHub.publish({
              runId,
              kind: terminalKind,
              payload: {
                run_id: runId,
                source: "historical_terminal",
                status: historicalRun.status,
              },
            });
            dispatchEvent(terminalEvent);
            return;
          }
        }
      } else if (historicalRun) {
        const snapshot = context.streamHub.publish({
          runId,
          kind: "snapshot",
          payload: snapshotPayloadForRun(historicalRun),
        });
        dispatchEvent(snapshot);
        const terminalKind = terminalEventForHistorical(historicalRun);
        if (terminalKind && !terminalSent) {
          const terminalEvent = context.streamHub.publish({
            runId,
            kind: terminalKind,
            payload: {
              run_id: runId,
              source: "historical_terminal",
              status: historicalRun.status,
            },
          });
          dispatchEvent(terminalEvent);
          return;
        }
      }

      if (terminalSent) return;

      unsubscribe = context.streamHub.subscribe(runId, (event) => {
        dispatchEvent(event);
      });

      keepalive = setInterval(() => {
        safeEnqueue(formatSseKeepalive());
      }, SSE_KEEPALIVE_INTERVAL_MS);

      if (request.signal) {
        request.signal.addEventListener("abort", () => {
          close();
        });
      }
    },
    cancel() {
      if (teardown) {
        teardown();
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

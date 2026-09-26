#!/usr/bin/env bun
/* eslint-disable no-console */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type StartedServer,
  startAgentProbeServer,
} from "../src/runtime/server/app-server.ts";
import { buildServerConfig } from "../src/runtime/server/config.ts";
import { METRIC_NAMES } from "../src/runtime/server/observability/index.ts";

type Mode = "ci" | "manual";

type SoakOptions = {
  mode: Mode;
  durationMs: number;
  runs: number;
  sseConnections: number;
};

function parseOptions(args: string[]): SoakOptions {
  const mode: Mode = args.includes("--manual") ? "manual" : "ci";
  const durationFlag = args.indexOf("--duration-ms");
  const durationMs =
    durationFlag !== -1
      ? Math.max(1_000, Number(args[durationFlag + 1] ?? ""))
      : mode === "manual"
        ? 60 * 60 * 1_000
        : 10_000;
  const runsFlag = args.indexOf("--runs");
  const runs =
    runsFlag !== -1
      ? Math.max(1, Number(args[runsFlag + 1] ?? ""))
      : mode === "manual"
        ? 500
        : 50;
  const sseFlag = args.indexOf("--sse-connections");
  const sseConnections =
    sseFlag !== -1
      ? Math.max(1, Number(args[sseFlag + 1] ?? ""))
      : mode === "manual"
        ? 5
        : 3;
  return { mode, durationMs, runs, sseConnections };
}

function writeMinimalSuite(root: string): string {
  const data = join(root, "data");
  mkdirSync(data, { recursive: true });
  writeFileSync(
    join(data, "endpoint.yaml"),
    [
      "transport: http",
      "connection:",
      "  base_url: http://example.test",
      "request:",
      "  method: POST",
      '  url: "{{ base_url }}/chat"',
      "  body_template: '{}'",
      "response:",
      "  format: text",
      '  content_path: "$"',
      "",
    ].join("\n"),
    "utf8",
  );
  return data;
}

type RssSample = { ts: number; rssMb: number };

function rssMb(): number {
  return process.memoryUsage.rss() / 1024 / 1024;
}

async function openSse(server: StartedServer, runId: string) {
  const response = await fetch(`${server.url}/api/runs/${runId}/events`);
  const reader = response.body?.getReader();
  if (!reader) return;
  let firstEventLag = Number.NaN;
  const start = performance.now();
  const read = async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (Number.isNaN(firstEventLag) && value && value.length > 0) {
          firstEventLag = performance.now() - start;
        }
      }
    } catch {
      // stream ended
    }
  };
  void read();
  return {
    cancel: async () => {
      try {
        await reader.cancel();
      } catch {
        // ignore
      }
    },
    firstEventLag: () => firstEventLag,
  };
}

async function runSoak(options: SoakOptions): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "agentprobe-soak-"));
  const dataPath = writeMinimalSuite(root);
  const dbPath = join(root, "runs.sqlite3");
  const server = await startAgentProbeServer(
    buildServerConfig({
      args: [
        "--host",
        "127.0.0.1",
        "--port",
        "0",
        "--data",
        dataPath,
        "--db",
        dbPath,
      ],
      env: {},
    }),
  );

  const endBy = Date.now() + options.durationMs;
  let runsStarted = 0;
  let failures = 0;
  const rssSamples: RssSample[] = [{ ts: Date.now(), rssMb: rssMb() }];

  const latencies: number[] = [];
  let openConnections = 0;
  const sseHandles: Awaited<ReturnType<typeof openSse>>[] = [];

  const ssePool = async (): Promise<void> => {
    for (let i = 0; i < options.sseConnections; i++) {
      const runId = `soak-sse-${i}`;
      server.streamHub.publish({
        runId,
        kind: "run_progress",
        payload: { kind: "scenario_started" },
      });
      const handle = await openSse(server, runId);
      if (handle) sseHandles.push(handle);
      openConnections += 1;
    }
  };

  await ssePool();

  while (Date.now() < endBy && runsStarted < options.runs) {
    const runId = `soak-run-${runsStarted}`;
    const t0 = performance.now();
    server.streamHub.publish({
      runId,
      kind: "run_started",
      payload: {
        run_id: runId,
        label: null,
        preset_id: null,
        trigger: "soak",
      },
    });
    // Simulate progress and terminal event.
    server.streamHub.publish({
      runId,
      kind: "scenario_started",
      payload: { scenario_id: "synthetic" },
    });
    server.streamHub.publish({
      runId,
      kind: "run_finished",
      payload: { kind: "run_finished", run_id: runId },
    });
    latencies.push(performance.now() - t0);
    runsStarted += 1;

    if (runsStarted % 25 === 0) {
      rssSamples.push({ ts: Date.now(), rssMb: rssMb() });
    }

    try {
      const response = await fetch(`${server.url}/api/runs`);
      await response.json();
    } catch {
      failures += 1;
    }
    // Yield to the event loop so stream subscribers can drain.
    await new Promise((resolve) => setImmediate(resolve));
  }

  rssSamples.push({ ts: Date.now(), rssMb: rssMb() });

  const activeRuns = server.observability.metrics.getGauge(
    METRIC_NAMES.runsActive,
  );
  const httpCounters = server.observability.metrics
    .snapshot()
    .counters.filter((entry) => entry.name === METRIC_NAMES.httpRequests)
    .reduce((total, entry) => total + entry.value, 0);
  const openSseGauge = server.observability.metrics.getGauge(
    METRIC_NAMES.sseConnections,
  );

  const firstEventLags = sseHandles
    .map((handle) => handle?.firstEventLag() ?? Number.NaN)
    .filter((value) => !Number.isNaN(value));
  const avgLag =
    firstEventLags.length > 0
      ? firstEventLags.reduce((sum, value) => sum + value, 0) /
        firstEventLags.length
      : 0;
  const p95Latency = latencies.length
    ? ([...latencies].sort((a, b) => a - b)[
        Math.floor(latencies.length * 0.95)
      ] ?? 0)
    : 0;

  for (const handle of sseHandles) {
    if (handle) await handle.cancel();
  }

  await server.stop();

  const summary = {
    mode: options.mode,
    duration_ms: Date.now() - (endBy - options.durationMs),
    runs: runsStarted,
    failures,
    http_requests: httpCounters,
    open_sse_connections_at_shutdown: openSseGauge,
    active_runs_at_shutdown: activeRuns,
    event_lag_ms_avg: Math.round(avgLag * 100) / 100,
    request_latency_ms_p95: Math.round(p95Latency * 100) / 100,
    rss_mb_start: rssSamples[0]?.rssMb ?? 0,
    rss_mb_end: rssSamples[rssSamples.length - 1]?.rssMb ?? 0,
    rss_mb_samples: rssSamples.length,
  };

  console.log(JSON.stringify(summary, null, 2));

  if (activeRuns !== 0) {
    console.error(
      `soak harness: expected 0 active runs at shutdown, got ${activeRuns}`,
    );
    process.exitCode = 1;
  }
  void openConnections;
}

void runSoak(parseOptions(process.argv.slice(2)));

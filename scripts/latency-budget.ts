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

type SampleKind =
  | "static.index"
  | "api.runs.list"
  | "api.runs.create"
  | "sse.first_event";

type Budget = {
  kind: SampleKind;
  label: string;
  p95Ms: number;
};

const BUDGETS: Budget[] = [
  { kind: "static.index", label: "GET / (index.html)", p95Ms: 150 },
  { kind: "api.runs.list", label: "GET /api/runs", p95Ms: 150 },
  {
    kind: "api.runs.create",
    label: "POST /api/runs (validation error)",
    p95Ms: 200,
  },
  {
    kind: "sse.first_event",
    label: "SSE /api/runs/:id/events first byte",
    p95Ms: 200,
  },
];

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

function parseFlag(args: string[], name: string, fallback: number): number {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const raw = args[index + 1];
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function percentile(values: number[], pct: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.ceil(sorted.length * pct) - 1);
  return sorted[Math.max(0, rank)] ?? 0;
}

async function timeRequest(
  fn: () => Promise<unknown>,
  samples: number,
): Promise<number[]> {
  const results: number[] = [];
  for (let i = 0; i < samples; i++) {
    const t0 = performance.now();
    try {
      await fn();
    } catch {
      // Errors are expected for some paths (e.g., validation-error runs).
    }
    results.push(performance.now() - t0);
  }
  return results;
}

async function measureSseFirstEvent(
  server: StartedServer,
  samples: number,
): Promise<number[]> {
  const results: number[] = [];
  for (let i = 0; i < samples; i++) {
    const runId = `latency-sse-${i}`;
    server.streamHub.publish({
      runId,
      kind: "run_progress",
      payload: { kind: "scenario_started" },
    });
    const t0 = performance.now();
    const response = await fetch(`${server.url}/api/runs/${runId}/events`);
    const reader = response.body?.getReader();
    if (!reader) continue;
    await reader.read();
    const duration = performance.now() - t0;
    await reader.cancel();
    results.push(duration);
  }
  return results;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const samples = parseFlag(args, "--samples", 20);
  const strict = !args.includes("--report-only");

  const root = mkdtempSync(join(tmpdir(), "agentprobe-latency-"));
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

  try {
    const staticSamples = await timeRequest(async () => {
      const response = await fetch(`${server.url}/`);
      await response.text();
    }, samples);

    const listSamples = await timeRequest(async () => {
      const response = await fetch(`${server.url}/api/runs`);
      await response.json();
    }, samples);

    const createSamples = await timeRequest(async () => {
      const response = await fetch(`${server.url}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      await response.text();
    }, samples);

    const sseSamples = await measureSseFirstEvent(server, samples);

    const recordings: Record<SampleKind, number[]> = {
      "static.index": staticSamples,
      "api.runs.list": listSamples,
      "api.runs.create": createSamples,
      "sse.first_event": sseSamples,
    };

    let exceeded = 0;
    console.log("kind\tlabel\tp50_ms\tp95_ms\tp99_ms\tbudget_ms\tstatus");
    for (const budget of BUDGETS) {
      const values = recordings[budget.kind];
      const p50 = percentile(values, 0.5);
      const p95 = percentile(values, 0.95);
      const p99 = percentile(values, 0.99);
      const ok = p95 <= budget.p95Ms;
      if (!ok) exceeded += 1;
      console.log(
        [
          budget.kind,
          budget.label,
          p50.toFixed(2),
          p95.toFixed(2),
          p99.toFixed(2),
          budget.p95Ms.toString(),
          ok ? "ok" : "over",
        ].join("\t"),
      );
    }

    if (exceeded > 0 && strict) {
      console.error(`\n${exceeded} budget(s) exceeded.`);
      process.exitCode = 1;
    }
  } finally {
    await server.stop();
  }
}

void main();

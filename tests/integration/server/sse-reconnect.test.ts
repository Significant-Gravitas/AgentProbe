import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  type StartedServer,
  startAgentProbeServer,
} from "../../../src/runtime/server/app-server.ts";
import { buildServerConfig } from "../../../src/runtime/server/config.ts";
import { METRIC_NAMES } from "../../../src/runtime/server/observability/index.ts";
import { makeTempDir } from "../../unit/support.ts";

function writeMinimalData(root: string): string {
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

async function readEnoughBytes(
  reader: ReadableStreamDefaultReader<Uint8Array<ArrayBufferLike>>,
  decoder: TextDecoder,
  predicate: (collected: string) => boolean,
  maxChunks = 10,
): Promise<string> {
  let collected = "";
  for (let i = 0; i < maxChunks; i++) {
    const result = await reader.read();
    if (result.done) break;
    collected += decoder.decode(result.value, { stream: true });
    if (predicate(collected)) break;
  }
  return collected;
}

async function startServer(servers: StartedServer[]): Promise<StartedServer> {
  const root = makeTempDir("sse-reconnect");
  const data = writeMinimalData(root);
  const dbPath = join(root, "runs.sqlite3");
  const args = [
    "--host",
    "127.0.0.1",
    "--port",
    "0",
    "--data",
    data,
    "--db",
    dbPath,
  ];
  const server = await startAgentProbeServer(
    buildServerConfig({ args, env: {} }),
  );
  servers.push(server);
  return server;
}

describe("sse hardening", () => {
  const servers: StartedServer[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await server.stop();
    }
  });

  test("replays missed events using last_event_id query and emits terminal close", async () => {
    const server = await startServer(servers);
    const runId = "run-reconnect";

    server.streamHub.publish({
      runId,
      kind: "run_started",
      payload: { run_id: runId, label: null, preset_id: null, trigger: "test" },
    });
    server.streamHub.publish({
      runId,
      kind: "run_progress",
      payload: { kind: "scenario_started", scenario_id: "smoke" },
    });

    const url = `${server.url}/api/runs/${runId}/events?last_event_id=1`;
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(response.headers.get("connection")).toBe("keep-alive");

    const reader = response.body?.getReader() as
      | ReadableStreamDefaultReader<Uint8Array<ArrayBufferLike>>
      | undefined;
    expect(reader).toBeDefined();
    if (!reader) return;
    const decoder = new TextDecoder();

    server.streamHub.publish({
      runId,
      kind: "run_finished",
      payload: { kind: "run_finished", run_id: runId },
    });

    const collected = await readEnoughBytes(reader, decoder, (text) =>
      text.includes("event: run_finished"),
    );
    await reader.cancel();

    expect(collected).toContain("retry: 2000");
    expect(collected).toContain("event: run_progress");
    expect(collected).not.toContain("event: run_started");
    expect(collected).toContain("event: run_finished");
  });

  test("metrics record http requests and active sse connections", async () => {
    const server = await startServer(servers);

    await fetch(`${server.url}/healthz`);
    const snapshot = server.observability.metrics.snapshot();
    const requestEntries = snapshot.counters.filter(
      (entry) => entry.name === METRIC_NAMES.httpRequests,
    );
    expect(requestEntries.length).toBeGreaterThan(0);
    expect(server.observability.metrics.getGauge(METRIC_NAMES.runsActive)).toBe(
      0,
    );

    const runId = "run-metrics";
    server.streamHub.publish({
      runId,
      kind: "run_progress",
      payload: { kind: "scenario_started" },
    });
    const events = await fetch(`${server.url}/api/runs/${runId}/events`);
    const reader = events.body?.getReader() as
      | ReadableStreamDefaultReader<Uint8Array<ArrayBufferLike>>
      | undefined;
    expect(reader).toBeDefined();
    if (!reader) return;
    const decoder = new TextDecoder();
    await readEnoughBytes(reader, decoder, (text) =>
      text.includes("event: run_progress"),
    );
    expect(
      server.observability.metrics.getGauge(METRIC_NAMES.sseConnections),
    ).toBe(1);
    await reader.cancel();
  });
});

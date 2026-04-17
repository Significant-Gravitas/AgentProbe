import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  type StartedServer,
  startAgentProbeServer,
} from "../../../src/runtime/server/app-server.ts";
import { buildServerConfig } from "../../../src/runtime/server/config.ts";
import { makeTempDir } from "../../unit/support.ts";

type RunStartResponse = {
  run_id: string;
  status: string;
};

type RunsResponse = {
  runs: Array<{
    runId: string;
    status: string;
    label?: string | null;
    trigger?: string | null;
    presetId?: string | null;
  }>;
};

type RunResponse = {
  run: {
    runId: string;
    status: string;
    trigger?: string | null;
    label?: string | null;
    presetId?: string | null;
    cancelledAt?: string | null;
    finalError?: { type?: string; message?: string } | null;
    presetSnapshot?: { name?: string };
  };
};

type PresetResponse = {
  preset: {
    id: string;
    name: string;
    selection: Array<{ file: string; id: string }>;
  };
};

function writeSuite(
  root: string,
  options: { targetUrl?: string; scenarioPersona?: string } = {},
): string {
  const data = join(root, "data");
  mkdirSync(data, { recursive: true });
  writeFileSync(
    join(data, "endpoint.yaml"),
    [
      "transport: http",
      "connection:",
      `  base_url: ${options.targetUrl ?? "http://example.test"}`,
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
  writeFileSync(
    join(data, "personas.yaml"),
    [
      "personas:",
      "  - id: analyst",
      "    name: Analyst",
      "    demographics:",
      "      role: operator",
      "      tech_literacy: high",
      "      domain_expertise: intermediate",
      "      language_style: terse",
      "    personality:",
      "      patience: 3",
      "      assertiveness: 3",
      "      detail_orientation: 4",
      "      cooperativeness: 4",
      "      emotional_intensity: 1",
      "    behavior:",
      "      opening_style: Direct.",
      "      follow_up_style: Concise.",
      "      escalation_triggers: []",
      "      topic_drift: none",
      "      clarification_compliance: high",
      "    system_prompt: You are direct.",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(data, "rubric.yaml"),
    [
      "judge:",
      "  provider: openai",
      "  model: anthropic/claude-opus-4.6",
      "  temperature: 0",
      "  max_tokens: 500",
      "rubrics:",
      "  - id: support",
      "    name: Support",
      "    pass_threshold: 0.7",
      '    meta_prompt: "Judge the answer."',
      "    dimensions:",
      "      - id: task_completion",
      "        name: Task Completion",
      "        weight: 1",
      "        scale:",
      "          type: likert",
      "          points: 5",
      '          labels: { "1": "bad", "5": "good" }',
      '        judge_prompt: "Score task completion."',
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(data, "scenarios.yaml"),
    [
      "scenarios:",
      "  - id: smoke",
      "    name: Smoke",
      "    tags: [smoke]",
      "    priority: high",
      `    persona: ${options.scenarioPersona ?? "analyst"}`,
      "    rubric: support",
      "    turns:",
      "      - role: user",
      "        content: Say hello.",
      "        use_exact_message: true",
      "    expectations:",
      "      expected_behavior: Greets the user.",
      "",
    ].join("\n"),
    "utf8",
  );
  return data;
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  expect(response.ok).toBe(true);
  return (await response.json()) as T;
}

async function waitForRun(
  server: StartedServer,
  runId: string,
): Promise<RunResponse["run"]> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const body = await json<RunResponse>(`${server.url}/api/runs/${runId}`);
    if (body.run.status !== "running") {
      return body.run;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Run ${runId} did not finish.`);
}

describe("server write control", () => {
  const servers: StartedServer[] = [];
  const targets: Array<ReturnType<typeof Bun.serve>> = [];
  const previousOpenRouterKey = Bun.env.OPEN_ROUTER_API_KEY;
  const previousScript = Bun.env.AGENTPROBE_E2E_OPENAI_SCRIPT;

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await server.stop();
    }
    for (const target of targets.splice(0)) {
      target.stop(true);
    }
    Bun.env.OPEN_ROUTER_API_KEY = previousOpenRouterKey;
    Bun.env.AGENTPROBE_E2E_OPENAI_SCRIPT = previousScript;
  });

  async function start(
    options: {
      token?: string;
      targetUrl?: string;
      scenarioPersona?: string;
    } = {},
  ) {
    Bun.env.OPEN_ROUTER_API_KEY = "integration-key";
    const root = makeTempDir("server-write");
    const data = writeSuite(root, {
      targetUrl: options.targetUrl,
      scenarioPersona: options.scenarioPersona,
    });
    const args = [
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--data",
      data,
      "--db",
      join(root, "runs.sqlite3"),
    ];
    if (options.token) {
      args.push("--token", options.token);
    }
    const server = await startAgentProbeServer(
      buildServerConfig({ args, env: {} }),
    );
    servers.push(server);
    return { server };
  }

  async function waitForExecutorLog(
    chunks: string[],
  ): Promise<Record<string, unknown> | undefined> {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      for (const line of chunks.flatMap((chunk) => chunk.split("\n"))) {
        if (!line.trim()) {
          continue;
        }
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (parsed.component === "run_executor") {
            return parsed;
          }
        } catch {}
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return undefined;
  }

  test("starts a dry-run, persists server metadata, and replays SSE progress", async () => {
    const { server } = await start();
    const started = await json<RunStartResponse>(`${server.url}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        endpoint: "endpoint.yaml",
        personas: "personas.yaml",
        rubric: "rubric.yaml",
        selection: [{ file: "scenarios.yaml", id: "smoke" }],
        dry_run: true,
        label: "dry-smoke",
      }),
    });

    expect(started.status).toBe("accepted");
    const run = await waitForRun(server, started.run_id);
    expect(run.trigger).toBe("server");
    expect(run.label).toBe("dry-smoke");

    const runs = await json<RunsResponse>(
      `${server.url}/api/runs?trigger=server`,
    );
    expect(runs.runs.map((item) => item.runId)).toContain(started.run_id);

    const events = await fetch(
      `${server.url}/api/runs/${started.run_id}/events`,
    );
    expect(events.status).toBe(200);
    const text = await events.text();
    expect(text).toContain("event: scenario_started");
    expect(text).toContain("event: run_finished");
  });

  test("logs and persists executor errors when runSuite throws", async () => {
    const stderrChunks: string[] = [];
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(((
      chunk: string | Uint8Array,
      ..._args: unknown[]
    ) => {
      stderrChunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);

    try {
      const { server } = await start({ scenarioPersona: "missing-persona" });
      const started = await json<RunStartResponse>(`${server.url}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          endpoint: "endpoint.yaml",
          personas: "personas.yaml",
          rubric: "rubric.yaml",
          selection: [{ file: "scenarios.yaml", id: "smoke" }],
          dry_run: true,
          label: "bad-persona",
        }),
      });

      expect(started.status).toBe("accepted");
      const run = await waitForRun(server, started.run_id);
      expect(run.status).toBe("config_error");
      expect(run.finalError?.type).toBe("AgentProbeConfigError");
      expect(run.finalError?.message).toContain("unknown persona");

      const executorLog = await waitForExecutorLog(stderrChunks);
      expect(executorLog).toMatchObject({
        level: "error",
        component: "run_executor",
        run_id: started.run_id,
        error_type: "AgentProbeConfigError",
      });
      expect(executorLog?.error_message).toContain("unknown persona");
      expect(typeof executorLog?.stack).toBe("string");
    } finally {
      stderrSpy.mockRestore();
    }
  });

  test("creates, updates, soft-deletes, and launches presets with frozen snapshots", async () => {
    const { server } = await start();
    const created = await json<PresetResponse>(`${server.url}/api/presets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "nightly",
        endpoint: "endpoint.yaml",
        personas: "personas.yaml",
        rubric: "rubric.yaml",
        selection: [{ file: "scenarios.yaml", id: "smoke" }],
        dry_run: true,
      }),
    });
    expect(created.preset.selection).toEqual([
      { file: "scenarios.yaml", id: "smoke" },
    ]);

    const launched = await json<RunStartResponse>(
      `${server.url}/api/presets/${created.preset.id}/runs`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "from-preset" }),
      },
    );
    const run = await waitForRun(server, launched.run_id);
    expect(run.presetId).toBe(created.preset.id);
    expect(run.presetSnapshot?.name).toBe("nightly");

    await json<PresetResponse>(
      `${server.url}/api/presets/${created.preset.id}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "nightly-renamed",
          endpoint: "endpoint.yaml",
          personas: "personas.yaml",
          rubric: "rubric.yaml",
          selection: [{ file: "scenarios.yaml", id: "smoke" }],
          dry_run: true,
        }),
      },
    );
    const historical = await json<RunResponse>(
      `${server.url}/api/runs/${launched.run_id}`,
    );
    expect(historical.run.presetSnapshot?.name).toBe("nightly");

    const deleted = await fetch(
      `${server.url}/api/presets/${created.preset.id}`,
      { method: "DELETE" },
    );
    expect(deleted.status).toBe(200);
    const list = await json<{ presets: PresetResponse["preset"][] }>(
      `${server.url}/api/presets`,
    );
    expect(list.presets.map((preset) => preset.id)).not.toContain(
      created.preset.id,
    );
  });

  test("protects write routes and rejects paths outside the data root", async () => {
    const { server } = await start({ token: "server-token" });
    const denied = await fetch(`${server.url}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(denied.status).toBe(401);

    const badPath = await fetch(`${server.url}/api/runs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer server-token",
      },
      body: JSON.stringify({
        endpoint: "../endpoint.yaml",
        personas: "personas.yaml",
        rubric: "rubric.yaml",
        selection: [{ file: "scenarios.yaml", id: "smoke" }],
        dry_run: true,
      }),
    });
    expect(badPath.status).toBe(400);
    expect(await badPath.text()).toContain("data root");
  });

  test("rejects duplicate active suite starts and cooperatively cancels", async () => {
    const target = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch() {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return new Response("Delayed ok.");
      },
    });
    targets.push(target);
    const root = makeTempDir("openai-script");
    const scriptPath = join(root, "openai.json");
    writeFileSync(
      scriptPath,
      JSON.stringify({
        rules: [
          {
            kind: "rubric_score",
            inputContains: ["Delayed ok."],
            output: {
              dimensions: {
                task_completion: {
                  reasoning: "Answered.",
                  evidence: ["Delayed ok."],
                  score: 5,
                },
              },
              overall_notes: "Good.",
              pass: true,
            },
          },
        ],
      }),
      "utf8",
    );
    Bun.env.AGENTPROBE_E2E_OPENAI_SCRIPT = scriptPath;
    const { server } = await start({
      targetUrl: `http://${target.hostname}:${target.port}`,
    });
    const payload = {
      endpoint: "endpoint.yaml",
      personas: "personas.yaml",
      rubric: "rubric.yaml",
      selection: [{ file: "scenarios.yaml", id: "smoke" }],
      dry_run: false,
    };
    const first = await json<RunStartResponse>(`${server.url}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const duplicate = await fetch(`${server.url}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(duplicate.status).toBe(409);

    const cancel = await fetch(
      `${server.url}/api/runs/${first.run_id}/cancel`,
      {
        method: "POST",
      },
    );
    expect(cancel.status).toBe(202);
    const run = await waitForRun(server, first.run_id);
    expect(run.status).toBe("cancelled");
    expect(run.cancelledAt).toBeTruthy();
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";

import {
  ASSISTANT_REPLIES,
  buildOpenAiRules,
  cleanupWorkspace,
  createWorkspace,
  type E2EWorkspace,
  FakeAutogptBackend,
  queryRows,
  readOpenAiLog,
  runAgentprobe,
  scenarioIds,
} from "./support.ts";

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

type GatewaySession = {
  sessionId: string;
  label?: string;
  messages: Array<Record<string, JsonValue>>;
};

type GatewaySocket = ServerWebSocket<{ nonce: string }>;

function jwtSubject(authorization: string | undefined): string | undefined {
  if (!authorization?.startsWith("Bearer ")) {
    return undefined;
  }
  const [, payload] = authorization.slice("Bearer ".length).split(".");
  if (!payload) {
    return undefined;
  }
  const decoded = JSON.parse(
    Buffer.from(payload, "base64url").toString("utf8"),
  ) as { sub?: string };
  return typeof decoded.sub === "string" ? decoded.sub : undefined;
}

async function waitForStderrMatch(
  stream: ReadableStream<Uint8Array> | null | undefined,
  pattern: RegExp,
  timeoutMs = 10_000,
): Promise<string> {
  if (!stream) {
    throw new Error("Expected a stderr stream.");
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const timeoutAt = Date.now() + timeoutMs;

  while (Date.now() < timeoutAt) {
    const remaining = Math.max(1, timeoutAt - Date.now());
    const read = await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        setTimeout(
          () => reject(new Error("Timed out waiting for stderr output.")),
          remaining,
        );
      }),
    ]);
    if (read.done) {
      break;
    }
    text += decoder.decode(read.value, { stream: true });
    if (pattern.test(text)) {
      return text;
    }
  }

  throw new Error(`Timed out waiting for stderr match: ${pattern}`);
}

class FakeOpenClawGateway {
  readonly sessions = new Map<string, GatewaySession>();
  private readonly deviceTokens = new Map<string, string>();
  private server?: ReturnType<typeof Bun.serve>;
  private sessionCounter = 0;
  private sessionIdCounter = 0;

  async start(): Promise<void> {
    const gateway = this;
    this.server = Bun.serve<{ nonce: string }>({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req, server) {
        const upgraded = server.upgrade(req, {
          data: { nonce: `nonce-${crypto.randomUUID()}` },
        });
        if (upgraded) {
          return undefined;
        }
        return new Response("upgrade failed", { status: 500 });
      },
      websocket: {
        open(ws) {
          ws.send(
            JSON.stringify({
              type: "event",
              event: "connect.challenge",
              payload: {
                nonce: ws.data.nonce,
                ts: 1_737_264_000_000,
              },
            }),
          );
        },
        message(ws, raw) {
          gateway.handleFrame(ws, raw);
        },
      },
    });
    await Bun.sleep(0);
  }

  async stop(): Promise<void> {
    this.server?.stop(true);
    this.server = undefined;
    await Bun.sleep(0);
  }

  get url(): string {
    return `ws://127.0.0.1:${this.server?.port ?? 0}`;
  }

  private handleFrame(ws: GatewaySocket, raw: string | Buffer): void {
    const frame = JSON.parse(String(raw)) as Record<string, unknown>;
    const method = frame.method;
    const requestId =
      typeof frame.id === "string" ? frame.id : crypto.randomUUID();
    const params =
      frame.params &&
      typeof frame.params === "object" &&
      !Array.isArray(frame.params)
        ? (frame.params as Record<string, unknown>)
        : {};

    if (method === "connect") {
      this.handleConnect(ws, requestId, params);
      return;
    }
    if (method === "health") {
      this.sendOk(ws, requestId, { status: "ok" });
      return;
    }
    if (method === "sessions.create") {
      const sessionKey =
        typeof params.key === "string" && params.key.trim()
          ? params.key.trim()
          : `session-${++this.sessionCounter}`;
      if (!this.sessions.has(sessionKey)) {
        this.sessions.set(sessionKey, {
          sessionId: `sess-${++this.sessionIdCounter}`,
          label: typeof params.label === "string" ? params.label : undefined,
          messages: [],
        });
      }
      const session = this.sessions.get(sessionKey);
      if (!session) {
        this.sendError(ws, requestId, "INVALID_REQUEST", "unknown session");
        return;
      }
      this.sendOk(ws, requestId, {
        ok: true,
        key: sessionKey,
        sessionId: session.sessionId,
        entry: {
          sessionId: session.sessionId,
          label: session.label ?? null,
        },
      });
      return;
    }
    if (method === "chat.send") {
      const sessionKey =
        typeof params.sessionKey === "string" ? params.sessionKey : undefined;
      const message =
        typeof params.message === "string" ? params.message : undefined;
      const session = sessionKey ? this.sessions.get(sessionKey) : undefined;
      const runId = crypto.randomUUID();
      if (!session || !message) {
        this.sendError(
          ws,
          requestId,
          "INVALID_REQUEST",
          "invalid chat.send params",
        );
        return;
      }
      session.messages.push({
        role: "user",
        content: [{ type: "text", text: message }],
      });
      const reply = `Echo: ${message}`;
      const assistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: reply }],
      } satisfies Record<string, JsonValue>;
      session.messages.push(assistantMessage);
      this.sendOk(ws, requestId, { runId, status: "started" });
      ws.send(
        JSON.stringify({
          type: "event",
          event: "chat",
          payload: {
            runId,
            sessionKey,
            seq: 0,
            state: "final",
            message: assistantMessage,
          },
        }),
      );
      return;
    }
    if (method === "chat.history") {
      const sessionKey =
        typeof params.sessionKey === "string" ? params.sessionKey : undefined;
      const session = sessionKey ? this.sessions.get(sessionKey) : undefined;
      if (!sessionKey || !session) {
        this.sendError(ws, requestId, "INVALID_REQUEST", "unknown session");
        return;
      }
      this.sendOk(ws, requestId, {
        sessionId: session.sessionId,
        messages: session.messages,
      });
      return;
    }

    this.sendError(
      ws,
      requestId,
      "INVALID_REQUEST",
      `unexpected method: ${String(method)}`,
    );
  }

  private handleConnect(
    ws: GatewaySocket,
    requestId: string,
    params: Record<string, unknown>,
  ): void {
    const device =
      params.device &&
      typeof params.device === "object" &&
      !Array.isArray(params.device)
        ? (params.device as Record<string, unknown>)
        : {};
    const auth =
      params.auth &&
      typeof params.auth === "object" &&
      !Array.isArray(params.auth)
        ? (params.auth as Record<string, unknown>)
        : {};
    const nonce = typeof device.nonce === "string" ? device.nonce : undefined;
    if (nonce !== ws.data.nonce) {
      this.sendError(ws, requestId, "INVALID_REQUEST", "nonce mismatch");
      return;
    }

    const deviceId =
      typeof device.id === "string"
        ? device.id
        : `device-${crypto.randomUUID()}`;
    const token =
      typeof auth.token === "string"
        ? auth.token
        : typeof auth.bootstrapToken === "string"
          ? auth.bootstrapToken
          : "";
    if (token !== "shared-token" && !token.startsWith("device-token-")) {
      this.sendError(ws, requestId, "AUTH_FAILED", "invalid token");
      return;
    }

    const deviceToken =
      this.deviceTokens.get(deviceId) ?? `device-token-${deviceId.slice(0, 8)}`;
    this.deviceTokens.set(deviceId, deviceToken);
    this.sendOk(ws, requestId, {
      protocol: 3,
      auth: { deviceToken, role: "operator", scopes: ["operator.read"] },
    });
  }

  private sendOk(
    ws: GatewaySocket,
    id: string,
    payload: Record<string, unknown>,
  ): void {
    ws.send(JSON.stringify({ type: "res", id, ok: true, payload }));
  }

  private sendError(
    ws: GatewaySocket,
    id: string,
    code: string,
    message: string,
  ): void {
    ws.send(
      JSON.stringify({
        type: "res",
        id,
        ok: false,
        error: { code, message },
      }),
    );
  }
}

describe("bun e2e baseline for the typescript cli", () => {
  let backend: FakeAutogptBackend;
  let workspace: E2EWorkspace;

  beforeEach(async () => {
    backend = await FakeAutogptBackend.start();
    workspace = await createWorkspace();
  });

  afterEach(async () => {
    await backend.stop();
    await cleanupWorkspace(workspace);
  });

  test("validate reports the fixture yaml suite", async () => {
    const result = await runAgentprobe(
      ["validate", "--data-path", workspace.suiteDir],
      {
        backendUrl: backend.url,
        suiteDir: workspace.suiteDir,
        workspace,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Processed YAML files:");
    expect(result.stdout).toContain("endpoints.yaml");
    expect(result.stdout).toContain("personas.yaml");
    expect(result.stdout).toContain("rubric.yaml");
    expect(result.stdout).toContain("scenarios.yaml");
  });

  test("run records the suite in sqlite and report renders both explicit and discovered outputs", async () => {
    await workspace.writeOpenAiScript(buildOpenAiRules());

    const runResult = await runAgentprobe(
      [
        "run",
        "--endpoint",
        workspace.endpointPath,
        "--scenarios",
        workspace.scenariosPath,
        "--personas",
        workspace.personasPath,
        "--rubric",
        workspace.rubricPath,
      ],
      {
        backendUrl: backend.url,
        suiteDir: workspace.suiteDir,
        workspace,
      },
    );

    expect(runResult.exitCode).toBe(0);
    expect(runResult.stderr).toContain("Running 2 scenarios...");
    expect(runResult.stderr).toContain("RUN refund-smoke");
    expect(runResult.stderr).toContain("RUN billing-followup");
    expect(runResult.stdout).toContain("PASS refund-smoke score=1.00");
    expect(runResult.stdout).toContain("PASS billing-followup score=0.80");
    expect(runResult.stdout).toContain("Summary: 2 passed, 0 failed, 2 total");

    expect(existsSync(workspace.dbPath)).toBe(true);

    const runRows = queryRows(
      workspace.dbPath,
      [
        "id",
        "status",
        "passed",
        "exit_code",
        "scenario_total",
        "scenario_passed_count",
        "selected_scenario_ids_json",
      ],
      "runs",
      "started_at DESC",
    );
    expect(runRows).toHaveLength(1);
    expect(runRows[0]?.status).toBe("completed");
    expect(runRows[0]?.passed).toBe(1);
    expect(runRows[0]?.exit_code).toBe(0);
    expect(runRows[0]?.scenario_total).toBe(2);
    expect(runRows[0]?.scenario_passed_count).toBe(2);
    expect(runRows[0]?.selected_scenario_ids_json).toEqual(scenarioIds);

    const scenarioRows = queryRows(
      workspace.dbPath,
      ["ordinal", "scenario_id", "status", "passed", "overall_score"],
      "scenario_runs",
      "ordinal ASC",
    );
    expect(scenarioRows).toEqual([
      {
        ordinal: 0,
        scenario_id: "refund-smoke",
        status: "completed",
        passed: 1,
        overall_score: 1,
      },
      {
        ordinal: 1,
        scenario_id: "billing-followup",
        status: "completed",
        passed: 1,
        overall_score: 0.8,
      },
    ]);

    expect(backend.countByKind("register_user")).toBe(2);
    expect(backend.countByKind("create_session")).toBe(2);
    expect(backend.countByKind("send_message")).toBe(2);

    const openAiLog = await readOpenAiLog(workspace.openAiLogPath);
    expect(openAiLog.map((entry) => entry.kind)).toEqual([
      "persona_step",
      "persona_step",
      "rubric_score",
      "persona_step",
      "persona_step",
      "rubric_score",
    ]);

    const explicitReport = await runAgentprobe(
      [
        "report",
        "--db-path",
        workspace.dbPath,
        "--output",
        workspace.explicitReportPath,
      ],
      {
        backendUrl: backend.url,
        suiteDir: workspace.suiteDir,
        workspace,
      },
    );

    expect(explicitReport.exitCode).toBe(0);
    expect(explicitReport.stdout.trim()).toBe(workspace.explicitReportPath);

    const explicitHtml = await readFile(workspace.explicitReportPath, "utf8");
    expect(explicitHtml).toContain("Refund smoke question");
    expect(explicitHtml).toContain(ASSISTANT_REPLIES["refund-smoke"]);
    expect(explicitHtml).toContain("Clear refund guidance.");

    const discoveredReport = await runAgentprobe(["report"], {
      backendUrl: backend.url,
      cwd: workspace.suiteDir,
      suiteDir: workspace.suiteDir,
      workspace,
    });

    const reportPath = join(
      workspace.suiteDir,
      `agentprobe-report-${runRows[0]?.id}.html`,
    );
    expect(discoveredReport.exitCode).toBe(0);
    expect(discoveredReport.stdout.trim()).toBe(reportPath);
    expect(existsSync(reportPath)).toBe(true);

    const discoveredHtml = await readFile(reportPath, "utf8");
    expect(discoveredHtml).toContain("Billing escalation follow-up");
    expect(discoveredHtml).toContain(ASSISTANT_REPLIES["billing-followup"]);
    expect(discoveredHtml).toContain("Solid escalation guidance.");
  });

  test("scenario-id filtering runs only the requested scenario", async () => {
    await workspace.writeOpenAiScript(buildOpenAiRules());

    const result = await runAgentprobe(
      [
        "run",
        "--endpoint",
        workspace.endpointPath,
        "--scenarios",
        workspace.scenariosPath,
        "--personas",
        workspace.personasPath,
        "--rubric",
        workspace.rubricPath,
        "--scenario-id",
        "billing-followup",
      ],
      {
        backendUrl: backend.url,
        suiteDir: workspace.suiteDir,
        workspace,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("refund-smoke");
    expect(result.stdout).toContain("PASS billing-followup score=0.80");

    const runRows = queryRows(
      workspace.dbPath,
      ["selected_scenario_ids_json"],
      "runs",
      "started_at DESC",
    );
    expect(runRows[0]?.selected_scenario_ids_json).toEqual([
      "billing-followup",
    ]);
    expect(backend.countByKind("send_message")).toBe(1);
  });

  test("--scenario flag alias works like --scenario-id", async () => {
    await workspace.writeOpenAiScript(buildOpenAiRules());

    const result = await runAgentprobe(
      [
        "run",
        "--endpoint",
        workspace.endpointPath,
        "--scenarios",
        workspace.scenariosPath,
        "--personas",
        workspace.personasPath,
        "--rubric",
        workspace.rubricPath,
        "--scenario",
        "billing-followup",
      ],
      {
        backendUrl: backend.url,
        suiteDir: workspace.suiteDir,
        workspace,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("refund-smoke");
    expect(result.stdout).toContain("PASS billing-followup score=0.80");

    const runRows = queryRows(
      workspace.dbPath,
      ["selected_scenario_ids_json"],
      "runs",
      "started_at DESC",
    );
    expect(runRows[0]?.selected_scenario_ids_json).toEqual([
      "billing-followup",
    ]);
  });

  test("--scenario filters by scenario name", async () => {
    await workspace.writeOpenAiScript(buildOpenAiRules());

    const result = await runAgentprobe(
      [
        "run",
        "--endpoint",
        workspace.endpointPath,
        "--scenarios",
        workspace.scenariosPath,
        "--personas",
        workspace.personasPath,
        "--rubric",
        workspace.rubricPath,
        "--scenario",
        "Billing escalation follow-up",
      ],
      {
        backendUrl: backend.url,
        suiteDir: workspace.suiteDir,
        workspace,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("refund-smoke");
    expect(result.stdout).toContain("PASS billing-followup score=0.80");

    const runRows = queryRows(
      workspace.dbPath,
      ["selected_scenario_ids_json"],
      "runs",
      "started_at DESC",
    );
    expect(runRows[0]?.selected_scenario_ids_json).toEqual([
      "billing-followup",
    ]);
    expect(backend.countByKind("send_message")).toBe(1);
  });

  test("tag filtering runs only matching scenarios", async () => {
    await workspace.writeOpenAiScript(buildOpenAiRules());

    const result = await runAgentprobe(
      [
        "run",
        "--endpoint",
        workspace.endpointPath,
        "--scenarios",
        workspace.scenariosPath,
        "--personas",
        workspace.personasPath,
        "--rubric",
        workspace.rubricPath,
        "--tags",
        "smoke",
      ],
      {
        backendUrl: backend.url,
        suiteDir: workspace.suiteDir,
        workspace,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("PASS refund-smoke score=1.00");
    expect(result.stdout).not.toContain("billing-followup");

    const runRows = queryRows(
      workspace.dbPath,
      ["selected_scenario_ids_json"],
      "runs",
      "started_at DESC",
    );
    expect(runRows[0]?.selected_scenario_ids_json).toEqual(["refund-smoke"]);
    expect(backend.countByKind("send_message")).toBe(1);
  });

  test("comma-separated --scenario-id runs multiple specific scenarios", async () => {
    await workspace.writeOpenAiScript(buildOpenAiRules());

    const result = await runAgentprobe(
      [
        "run",
        "--endpoint",
        workspace.endpointPath,
        "--scenarios",
        workspace.scenariosPath,
        "--personas",
        workspace.personasPath,
        "--rubric",
        workspace.rubricPath,
        "--scenario-id",
        "refund-smoke,billing-followup",
      ],
      {
        backendUrl: backend.url,
        suiteDir: workspace.suiteDir,
        workspace,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("PASS refund-smoke score=1.00");
    expect(result.stdout).toContain("PASS billing-followup score=0.80");

    const runRows = queryRows(
      workspace.dbPath,
      ["selected_scenario_ids_json"],
      "runs",
      "started_at DESC",
    );
    expect(runRows[0]?.selected_scenario_ids_json).toEqual([
      "refund-smoke",
      "billing-followup",
    ]);
    expect(backend.countByKind("send_message")).toBe(2);
  });

  test("list command shows available scenarios", async () => {
    const result = await runAgentprobe(
      ["list", "--scenarios", workspace.scenariosPath],
      {
        backendUrl: backend.url,
        suiteDir: workspace.suiteDir,
        workspace,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "refund-smoke: Refund smoke question [smoke]",
    );
    expect(result.stdout).toContain(
      "billing-followup: Billing escalation follow-up [regression]",
    );
  });

  test("list command with --tags filters scenarios", async () => {
    const result = await runAgentprobe(
      ["list", "--scenarios", workspace.scenariosPath, "--tags", "smoke"],
      {
        backendUrl: backend.url,
        suiteDir: workspace.suiteDir,
        workspace,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "refund-smoke: Refund smoke question [smoke]",
    );
    expect(result.stdout).not.toContain("billing-followup");
  });

  test("no-match filtering returns a configuration error without target traffic", async () => {
    await workspace.writeOpenAiScript({ rules: [] });

    const result = await runAgentprobe(
      [
        "run",
        "--endpoint",
        workspace.endpointPath,
        "--scenarios",
        workspace.scenariosPath,
        "--personas",
        workspace.personasPath,
        "--rubric",
        workspace.rubricPath,
        "--tags",
        "does-not-exist",
      ],
      {
        backendUrl: backend.url,
        suiteDir: workspace.suiteDir,
        workspace,
      },
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(
      "Configuration error: No scenarios matched the requested filters.",
    );
    expect(backend.requestLog).toHaveLength(0);
    expect(await readOpenAiLog(workspace.openAiLogPath)).toHaveLength(0);
  });

  test("no-match scenario-id returns a configuration error with available ids", async () => {
    await workspace.writeOpenAiScript({ rules: [] });

    const result = await runAgentprobe(
      [
        "run",
        "--endpoint",
        workspace.endpointPath,
        "--scenarios",
        workspace.scenariosPath,
        "--personas",
        workspace.personasPath,
        "--rubric",
        workspace.rubricPath,
        "--scenario-id",
        "does-not-exist",
      ],
      {
        backendUrl: backend.url,
        suiteDir: workspace.suiteDir,
        workspace,
      },
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("does-not-exist");
    expect(result.stderr).toContain("refund-smoke");
    expect(result.stderr).toContain("billing-followup");
    expect(backend.requestLog).toHaveLength(0);
  });

  test("dry-run avoids backend and openai calls while still recording the run", async () => {
    await workspace.writeOpenAiScript({ rules: [] });

    const result = await runAgentprobe(
      [
        "run",
        "--endpoint",
        workspace.endpointPath,
        "--scenarios",
        workspace.scenariosPath,
        "--personas",
        workspace.personasPath,
        "--rubric",
        workspace.rubricPath,
        "--dry-run",
      ],
      {
        backendUrl: backend.url,
        suiteDir: workspace.suiteDir,
        workspace,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("PASS refund-smoke score=0.00");
    expect(result.stdout).toContain("PASS billing-followup score=0.00");
    expect(result.stdout).toContain("Summary: 2 passed, 0 failed, 2 total");
    expect(backend.requestLog).toHaveLength(0);
    expect(await readOpenAiLog(workspace.openAiLogPath)).toHaveLength(0);

    const runRows = queryRows(
      workspace.dbPath,
      [
        "status",
        "scenario_total",
        "scenario_passed_count",
        "selected_scenario_ids_json",
      ],
      "runs",
      "started_at DESC",
    );
    expect(runRows[0]).toEqual({
      status: "completed",
      scenario_total: 0,
      scenario_passed_count: 0,
      selected_scenario_ids_json: scenarioIds,
    });

    const scenarioRows = queryRows(
      workspace.dbPath,
      ["scenario_id"],
      "scenario_runs",
      "ordinal ASC",
    );
    expect(scenarioRows).toHaveLength(0);
  });

  test("parallel preserves result ordering while overlapping target requests", async () => {
    await workspace.writeOpenAiScript(buildOpenAiRules());
    backend.enableSendBarrier(2);

    const result = await runAgentprobe(
      [
        "run",
        "--endpoint",
        workspace.endpointPath,
        "--scenarios",
        workspace.scenariosPath,
        "--personas",
        workspace.personasPath,
        "--rubric",
        workspace.rubricPath,
        "--parallel",
        "2",
      ],
      {
        backendUrl: backend.url,
        suiteDir: workspace.suiteDir,
        workspace,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("PASS refund-smoke score=1.00");
    expect(result.stdout).toContain("PASS billing-followup score=0.80");
    expect(backend.maxConcurrentSends).toBeGreaterThanOrEqual(2);

    const scenarioRows = queryRows(
      workspace.dbPath,
      ["ordinal", "scenario_id"],
      "scenario_runs",
      "ordinal ASC",
    );
    expect(scenarioRows).toEqual([
      { ordinal: 0, scenario_id: "refund-smoke" },
      { ordinal: 1, scenario_id: "billing-followup" },
    ]);
  });

  test("repeat mode uses distinct pinned AutoGPT users per iteration", async () => {
    await workspace.writeOpenAiScript(buildOpenAiRules());

    const result = await runAgentprobe(
      [
        "run",
        "--endpoint",
        workspace.endpointPath,
        "--scenarios",
        workspace.scenariosPath,
        "--personas",
        workspace.personasPath,
        "--rubric",
        workspace.rubricPath,
        "--scenario-id",
        "refund-smoke",
        "--repeat",
        "2",
      ],
      {
        backendUrl: backend.url,
        suiteDir: workspace.suiteDir,
        workspace,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("RUN refund-smoke");
    expect(result.stderr).toContain("RUN refund-smoke#2");

    const scenarioRows = queryRows(
      workspace.dbPath,
      ["ordinal", "scenario_id", "user_id"],
      "scenario_runs",
      "ordinal ASC",
    );
    expect(scenarioRows).toEqual([
      {
        ordinal: 0,
        scenario_id: "refund-smoke",
        user_id: scenarioRows[0]?.user_id,
      },
      {
        ordinal: 1,
        scenario_id: "refund-smoke",
        user_id: scenarioRows[1]?.user_id,
      },
    ]);
    expect(scenarioRows[0]?.user_id).not.toBe(scenarioRows[1]?.user_id);

    const subjects = backend.requestLog
      .filter((entry) => entry.kind === "register_user")
      .map((entry) => jwtSubject(entry.headers.authorization))
      .filter((value): value is string => typeof value === "string");
    expect(new Set(subjects).size).toBe(2);
    expect(subjects).toEqual(scenarioRows.map((row) => String(row.user_id)));
  });

  test("dashboard mode serves live state from the Bun dashboard server", async () => {
    await workspace.writeOpenAiScript(buildOpenAiRules());
    backend.enableSendBarrier(2);

    const env = {
      ...Bun.env,
      OPEN_ROUTER_API_KEY: "e2e-openrouter-key",
      AUTOGPT_BACKEND_URL: backend.url,
      AGENTPROBE_E2E_OPENAI_SCRIPT: workspace.openAiScriptPath,
      AGENTPROBE_E2E_OPENAI_LOG: workspace.openAiLogPath,
      AGENTPROBE_DISABLE_BROWSER_OPEN: "1",
    };
    const process = Bun.spawn({
      cmd: [
        "bun",
        "run",
        "agentprobe",
        "--data-path",
        workspace.suiteDir,
        "run",
        "--endpoint",
        workspace.endpointPath,
        "--scenarios",
        workspace.scenariosPath,
        "--personas",
        workspace.personasPath,
        "--rubric",
        workspace.rubricPath,
        "--parallel",
        "--dashboard",
      ],
      cwd: workspace.suiteDir,
      env,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });

    const stderr = await waitForStderrMatch(
      process.stderr,
      /Dashboard: (http:\/\/\S+)/,
    );
    const dashboardUrl = stderr.match(/Dashboard: (http:\/\/\S+)/)?.[1];
    expect(dashboardUrl).toBeDefined();

    const stateResponse = await fetch(`${dashboardUrl}/api/state`);
    const state = (await stateResponse.json()) as {
      total: number;
      scenarios: Array<{ scenario_id: string }>;
    };
    expect(state.total).toBe(2);
    expect(state.scenarios.map((scenario) => scenario.scenario_id)).toEqual([
      "refund-smoke",
      "billing-followup",
    ]);

    const exitCode = await Promise.race([
      process.exited,
      new Promise<number>((_resolve, reject) => {
        setTimeout(() => reject(new Error("dashboard e2e timed out")), 30_000);
      }),
    ]);
    const stdout = await new Response(process.stdout).text();

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Summary: 2 passed, 0 failed, 2 total");
  });

  test("openclaw commands create sessions, chat, and read history through the cli", async () => {
    const gateway = new FakeOpenClawGateway();
    await gateway.start();

    try {
      const endpointPath = join(workspace.rootDir, "openclaw-endpoint.yaml");
      await writeFile(
        endpointPath,
        [
          "preset: openclaw",
          "transport: websocket",
          "connection:",
          `  url: "${gateway.url}"`,
          "  timeout_seconds: 30",
          "  max_retries: 1",
          "websocket:",
          "  connect:",
          "    challenge_event: connect.challenge",
          "    method: connect",
          "    params:",
          "      client:",
          "        id: openclaw-probe",
          '        version: "0.1.0"',
          "        platform: typescript",
          "        mode: probe",
          "      role: operator",
          "      scopes:",
          "        - operator.read",
          "        - operator.write",
          "      auth:",
          '        token: "shared-token"',
          "health_check:",
          "  enabled: true",
          "",
        ].join("\n"),
        "utf8",
      );

      const createSession = await runAgentprobe(
        [
          "openclaw",
          "create-session",
          "--endpoint",
          endpointPath,
          "--session-key",
          "support-1",
          "--label",
          "Support session",
        ],
        {
          backendUrl: backend.url,
          suiteDir: workspace.suiteDir,
          workspace,
          extraEnv: {
            AGENTPROBE_STATE_DIR: workspace.rootDir,
            OPENCLAW_GATEWAY_URL: gateway.url,
            OPENCLAW_GATEWAY_TOKEN: "shared-token",
          },
        },
      );

      expect(createSession.exitCode).toBe(0);
      const createSessionPayload = JSON.parse(createSession.stdout) as {
        entry?: { label?: string; sessionId?: string };
        key: string;
        sessionId?: string;
      };
      expect(createSessionPayload.key).toBe("support-1");
      expect(createSessionPayload.sessionId).toBe("sess-1");
      expect(createSessionPayload.entry?.sessionId).toBe("sess-1");
      expect(createSessionPayload.entry?.label).toBe("Support session");

      const chat = await runAgentprobe(
        [
          "openclaw",
          "chat",
          "--endpoint",
          endpointPath,
          "--session-key",
          "support-1",
          "--message",
          "from e2e",
        ],
        {
          backendUrl: backend.url,
          suiteDir: workspace.suiteDir,
          workspace,
          extraEnv: {
            AGENTPROBE_STATE_DIR: workspace.rootDir,
            OPENCLAW_GATEWAY_URL: gateway.url,
            OPENCLAW_GATEWAY_TOKEN: "shared-token",
          },
        },
      );

      expect(chat.exitCode).toBe(0);
      const chatPayload = JSON.parse(chat.stdout) as {
        reply: string;
        sessionKey: string;
        status: string;
      };
      expect(chatPayload.status).toBe("ok");
      expect(chatPayload.sessionKey).toBe("support-1");
      expect(chatPayload.reply).toBe("Echo: from e2e");

      const history = await runAgentprobe(
        [
          "openclaw",
          "history",
          "--endpoint",
          endpointPath,
          "--session-key",
          "support-1",
        ],
        {
          backendUrl: backend.url,
          suiteDir: workspace.suiteDir,
          workspace,
          extraEnv: {
            AGENTPROBE_STATE_DIR: workspace.rootDir,
            OPENCLAW_GATEWAY_URL: gateway.url,
            OPENCLAW_GATEWAY_TOKEN: "shared-token",
          },
        },
      );

      expect(history.exitCode).toBe(0);
      const historyPayload = JSON.parse(history.stdout) as {
        messages: Array<{ role: string }>;
        sessionId: string;
      };
      expect(historyPayload.sessionId).toBe("sess-1");
      expect(historyPayload.messages.map((message) => message.role)).toEqual([
        "user",
        "assistant",
      ]);
      expect(gateway.sessions.get("support-1")?.messages).toHaveLength(2);
    } finally {
      await gateway.stop();
    }
  });
});

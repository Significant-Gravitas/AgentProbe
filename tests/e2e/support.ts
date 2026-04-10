import { Database } from "bun:sqlite";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { delimiter, dirname, join, resolve } from "node:path";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(THIS_DIR, "..", "..");
const FIXTURE_SUITE_DIR = join(REPO_ROOT, "tests", "e2e", "fixtures", "suite");

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

type RunOptions = {
  backendUrl: string;
  cwd?: string;
  suiteDir: string;
  workspace: E2EWorkspace;
  timeoutMs?: number;
};

type CmdResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

export type OpenAiRule = {
  name: string;
  kind: "persona_step" | "rubric_score";
  inputContains?: string[];
  instructionsContains?: string[];
  output: JsonValue;
};

export type OpenAiScript = {
  rules: OpenAiRule[];
};

export type OpenAiLogEntry = {
  kind: string;
  matched_rule: string;
  model: string | null;
  input: string;
};

export type RequestRecord = {
  kind: "register_user" | "create_session" | "send_message";
  method: string;
  path: string;
  headers: Record<string, string>;
  body: JsonValue;
  sessionId?: string;
  scenarioId?: string;
  startedAt: number;
  endedAt: number;
};

export type E2EWorkspace = {
  rootDir: string;
  suiteDir: string;
  endpointPath: string;
  scenariosPath: string;
  personasPath: string;
  rubricPath: string;
  dbPath: string;
  explicitReportPath: string;
  openAiScriptPath: string;
  openAiLogPath: string;
  writeOpenAiScript: (script: OpenAiScript) => Promise<void>;
};

export const scenarioIds = ["refund-smoke", "billing-followup"];

export const ASSISTANT_REPLIES: Record<string, string> = {
  "refund-smoke": "Refunds stay available within 30 days for eligible orders.",
  "billing-followup":
    "I can escalate the duplicate charge and connect you to billing.",
};

const REFUND_GUIDANCE = "Ask whether you can still get a refund for order R-100.";
const BILLING_GUIDANCE =
  "Explain that you were charged twice for invoice INV-200.";

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function buildEnvPath(value: string, current?: string): string {
  return current ? `${value}${delimiter}${current}` : value;
}

async function streamToText(
  stream: ReadableStream<Uint8Array> | null | undefined,
): Promise<string> {
  if (!stream) {
    return "";
  }
  return await new Response(stream).text();
}

function normalizeJsonColumns(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => {
      if (typeof value !== "string") {
        return [key, value];
      }

      const trimmed = value.trim();
      if (
        !trimmed.startsWith("{") &&
        !trimmed.startsWith("[") &&
        trimmed !== "null" &&
        trimmed !== "true" &&
        trimmed !== "false"
      ) {
        return [key, value];
      }

      try {
        return [key, JSON.parse(trimmed)];
      } catch {
        return [key, value];
      }
    }),
  );
}

async function assertProcessCompletes(
  process: Bun.Subprocess<"ignore", "pipe", "pipe">,
  timeoutMs: number,
): Promise<number> {
  const timer = setTimeout(() => {
    process.kill();
  }, timeoutMs);

  try {
    return await process.exited;
  } finally {
    clearTimeout(timer);
  }
}

function responseBodyForScenario(scenarioId: string | undefined): string {
  const assistantText =
    (scenarioId && ASSISTANT_REPLIES[scenarioId]) || "Unhandled scenario response.";
  return [
    `data: ${JSON.stringify({ delta: assistantText })}`,
    "",
    `data: ${JSON.stringify({ delta: "", usage: { output_tokens: 24 } })}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n");
}

export class FakeAutogptBackend {
  private readonly sessionToScenario = new Map<string, string>();
  private readonly sessionToLabel = new Map<string, string>();
  private readonly requestCounter = { current: 0 };
  private readonly sendBarrier = {
    expected: 0,
    arrived: 0,
    gate: createDeferred<void>(),
  };

  readonly requestLog: RequestRecord[] = [];
  readonly server: ReturnType<typeof Bun.serve>;
  maxConcurrentSends = 0;
  private activeSends = 0;

  private constructor(server: ReturnType<typeof Bun.serve>) {
    this.server = server;
  }

  static async start(): Promise<FakeAutogptBackend> {
    let backend!: FakeAutogptBackend;
    backend = new FakeAutogptBackend(
      Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request: Request): Promise<Response> {
          return backend.handle(request);
        },
      }),
    );
    return backend;
  }

  get url(): string {
    return `http://127.0.0.1:${this.server.port}`;
  }

  async stop(): Promise<void> {
    this.server.stop(true);
  }

  countByKind(kind: RequestRecord["kind"]): number {
    return this.requestLog.filter((record) => record.kind === kind).length;
  }

  enableSendBarrier(expected: number): void {
    this.sendBarrier.expected = expected;
    this.sendBarrier.arrived = 0;
    this.sendBarrier.gate = createDeferred<void>();
  }

  private async waitForSendBarrier(): Promise<void> {
    if (this.sendBarrier.expected <= 0) {
      return;
    }

    this.sendBarrier.arrived += 1;
    if (this.sendBarrier.arrived >= this.sendBarrier.expected) {
      this.sendBarrier.gate.resolve();
      return;
    }

    await this.sendBarrier.gate.promise;
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const headers = Object.fromEntries(request.headers.entries());
    const startedAt = Date.now();
    const recordBase = {
      method: request.method,
      path: url.pathname,
      headers,
      startedAt,
    };

    if (request.method === "POST" && url.pathname === "/api/auth/user") {
      const record: RequestRecord = {
        ...recordBase,
        kind: "register_user",
        body: null,
        endedAt: Date.now(),
      };
      this.requestLog.push(record);
      return Response.json({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/api/chat/sessions") {
      const body = (await request.json()) as { dry_run?: boolean; title?: string };
      const sessionId = `session-${++this.requestCounter.current}`;
      const scenarioId =
        typeof body.title === "string"
          ? body.title.replace("AgentProbe: ", "").split(" / ")[0]
          : "unknown-scenario";
      this.sessionToScenario.set(sessionId, scenarioId);
      this.sessionToLabel.set(sessionId, String(body.title ?? ""));
      this.requestLog.push({
        ...recordBase,
        kind: "create_session",
        body,
        sessionId,
        scenarioId,
        endedAt: Date.now(),
      });
      return Response.json({ id: sessionId });
    }

    const sendMatch = url.pathname.match(/^\/api\/chat\/sessions\/([^/]+)\/stream$/);
    if (request.method === "POST" && sendMatch) {
      const sessionId = sendMatch[1] ?? "";
      const scenarioId = this.sessionToScenario.get(sessionId);
      const body = (await request.json()) as JsonValue;

      this.activeSends += 1;
      this.maxConcurrentSends = Math.max(this.maxConcurrentSends, this.activeSends);
      await this.waitForSendBarrier();
      this.activeSends -= 1;

      this.requestLog.push({
        ...recordBase,
        kind: "send_message",
        body,
        sessionId,
        scenarioId,
        endedAt: Date.now(),
      });

      return new Response(responseBodyForScenario(scenarioId), {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        },
      });
    }

    return new Response(`Unexpected route: ${request.method} ${url.pathname}`, {
      status: 404,
    });
  }
}

export async function createWorkspace(): Promise<E2EWorkspace> {
  const rootDir = await mkdtemp(join(REPO_ROOT, ".tmp-agentprobe-e2e-"));
  const suiteDir = join(rootDir, "suite");
  await cp(FIXTURE_SUITE_DIR, suiteDir, { recursive: true });

  const openAiScriptPath = join(rootDir, "openai-script.json");
  const openAiLogPath = join(rootDir, "openai-log.ndjson");
  await writeFile(openAiScriptPath, JSON.stringify({ rules: [] }, null, 2), "utf8");
  await writeFile(openAiLogPath, "", "utf8");

  return {
    rootDir,
    suiteDir,
    endpointPath: join(suiteDir, "endpoints.yaml"),
    scenariosPath: join(suiteDir, "scenarios.yaml"),
    personasPath: join(suiteDir, "personas.yaml"),
    rubricPath: join(suiteDir, "rubric.yaml"),
    dbPath: join(suiteDir, ".agentprobe", "runs.sqlite3"),
    explicitReportPath: join(rootDir, "report.html"),
    openAiScriptPath,
    openAiLogPath,
    async writeOpenAiScript(script: OpenAiScript): Promise<void> {
      await writeFile(openAiScriptPath, JSON.stringify(script, null, 2), "utf8");
      await writeFile(openAiLogPath, "", "utf8");
    },
  };
}

export async function cleanupWorkspace(workspace: E2EWorkspace): Promise<void> {
  await rm(workspace.rootDir, { recursive: true, force: true });
}

export async function runAgentprobe(
  args: string[],
  options: RunOptions,
): Promise<CmdResult> {
  const env = {
    ...Bun.env,
    OPEN_ROUTER_API_KEY: "e2e-openrouter-key",
    AUTOGPT_BACKEND_URL: options.backendUrl,
    AGENTPROBE_E2E_OPENAI_SCRIPT: options.workspace.openAiScriptPath,
    AGENTPROBE_E2E_OPENAI_LOG: options.workspace.openAiLogPath,
  };

  const process = Bun.spawn({
    cmd: [
      "bun",
      "run",
      "agentprobe",
      "--data-path",
      options.suiteDir,
      ...args,
    ],
    cwd: options.cwd ?? options.suiteDir,
    env,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    assertProcessCompletes(process, options.timeoutMs ?? 30_000),
    streamToText(process.stdout),
    streamToText(process.stderr),
  ]);

  return { exitCode, stdout, stderr };
}

export async function readOpenAiLog(path: string): Promise<OpenAiLogEntry[]> {
  const content = await readFile(path, "utf8");
  if (!content.trim()) {
    return [];
  }

  return content
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line: string) => JSON.parse(line) as OpenAiLogEntry);
}

export function queryRows(
  dbPath: string,
  columns: string[],
  tableName: string,
  orderBy: string,
): Record<string, unknown>[] {
  const database = new Database(dbPath);
  try {
    const query = database.query(
      `select ${columns.join(", ")} from ${tableName} order by ${orderBy}`,
    );
    const rows = query.all() as Record<string, unknown>[];
    return rows.map((row) => normalizeJsonColumns(row));
  } finally {
    database.close();
  }
}

export function buildOpenAiRules(): OpenAiScript {
  return {
    rules: [
      {
        name: "refund-scripted-turn",
        kind: "persona_step",
        inputContains: [REFUND_GUIDANCE, "A response is required for this scripted turn."],
        output: {
          message: "Can I still get a refund for order R-100?",
        },
      },
      {
        name: "refund-follow-up-complete",
        kind: "persona_step",
        inputContains: [ASSISTANT_REPLIES["refund-smoke"], "Decide whether the persona would continue"],
        output: {
          status: "completed",
        },
      },
      {
        name: "refund-judge",
        kind: "rubric_score",
        inputContains: [ASSISTANT_REPLIES["refund-smoke"]],
        output: {
          dimensions: {
            task_completion: {
              reasoning: "The agent explained the refund policy clearly.",
              evidence: ["Mentioned the 30-day refund window."],
              score: 5,
            },
          },
          overall_notes: "Clear refund guidance.",
          pass: true,
        },
      },
      {
        name: "billing-scripted-turn",
        kind: "persona_step",
        inputContains: [BILLING_GUIDANCE, "A response is required for this scripted turn."],
        output: {
          message: "I was charged twice for invoice INV-200.",
        },
      },
      {
        name: "billing-follow-up-complete",
        kind: "persona_step",
        inputContains: [ASSISTANT_REPLIES["billing-followup"], "Decide whether the persona would continue"],
        output: {
          status: "completed",
        },
      },
      {
        name: "billing-judge",
        kind: "rubric_score",
        inputContains: [ASSISTANT_REPLIES["billing-followup"]],
        output: {
          dimensions: {
            task_completion: {
              reasoning: "The agent gave a plausible escalation path.",
              evidence: ["Offered to connect the user to billing."],
              score: 4,
            },
          },
          overall_notes: "Solid escalation guidance.",
          pass: true,
        },
      },
    ],
  };
}

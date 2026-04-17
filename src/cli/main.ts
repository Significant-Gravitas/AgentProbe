import { dirname, resolve } from "node:path";

import { runSuite } from "../domains/evaluation/run-suite.ts";
import { startDashboardServer } from "../domains/reporting/dashboard.ts";
import { writeRunReport } from "../domains/reporting/render-report.ts";
import {
  parseScenariosInput,
  processYamlFiles,
} from "../domains/validation/load-suite.ts";
import { runMigrations } from "../providers/persistence/migrations/index.ts";
import {
  DEFAULT_DB_DIRNAME,
  DEFAULT_DB_FILENAME,
  SqliteRunRecorder,
} from "../providers/persistence/sqlite-run-history.ts";
import { parseDbUrl, redactDbUrl } from "../providers/persistence/url.ts";
import { OpenAiResponsesClient } from "../providers/sdk/openai-responses.ts";
import {
  loadConfiguredEndpoint,
  OpenClawGatewayClient,
  openclawChat,
  openclawHistory,
} from "../providers/sdk/openclaw.ts";
import { startAgentProbeServer } from "../runtime/server/app-server.ts";
import { buildServerConfig } from "../runtime/server/config.ts";
import type { RunProgressEvent, RunResult } from "../shared/types/contracts.ts";
import {
  AgentProbeConfigError,
  AgentProbeRuntimeError,
} from "../shared/utils/errors.ts";
import { setLogLevel } from "../shared/utils/logging.ts";

type GlobalCliOptions = {
  args: string[];
  dataPath?: string;
  verbosity: 0 | 1 | 2;
};

type DashboardScenarioSeed = {
  ordinal: number;
  displayId: string;
  scenarioName?: string | null;
};

function formatScore(score: number): string {
  return score.toFixed(2);
}

function commonParent(paths: string[]): string {
  const splitPaths = paths.map((path) =>
    resolve(path).split("/").filter(Boolean),
  );
  const first = splitPaths[0] ?? [];
  const shared: string[] = [];
  for (let index = 0; index < first.length; index += 1) {
    const segment = first[index];
    if (splitPaths.every((parts) => parts[index] === segment)) {
      shared.push(segment);
    } else {
      break;
    }
  }
  return `/${shared.join("/")}`;
}

function suiteDbUrl(paths: string[]): string {
  const parent = commonParent(paths.map((path) => dirname(resolve(path))));
  return `sqlite:///${resolve(parent, DEFAULT_DB_DIRNAME, DEFAULT_DB_FILENAME)}`;
}

function dbUrlFromPath(dbPath?: string): string | undefined {
  return dbPath ? `sqlite:///${resolve(dbPath)}` : undefined;
}

function progressPrefix(event: RunProgressEvent): string {
  if (!event.scenarioIndex || !event.scenarioTotal) {
    return "";
  }
  return `[${event.scenarioIndex}/${event.scenarioTotal}] `;
}

function scenarioLabel(event: RunProgressEvent): string {
  const scenarioId = event.scenarioId ?? "unknown-scenario";
  if (event.scenarioName && event.scenarioName !== scenarioId) {
    return `${scenarioId} (${event.scenarioName})`;
  }
  return scenarioId;
}

function printRunProgress(event: RunProgressEvent): void {
  if (event.kind === "suite_started") {
    const total = event.scenarioTotal ?? 0;
    console.error(
      `Running ${total} ${total === 1 ? "scenario" : "scenarios"}...`,
    );
    return;
  }
  const prefix = progressPrefix(event);
  const label = scenarioLabel(event);
  if (event.kind === "scenario_started") {
    console.error(`${prefix}RUN ${label}`);
    return;
  }
  if (event.kind === "scenario_finished") {
    console.error(
      `${prefix}${event.passed ? "PASS" : "FAIL"} ${label}${
        typeof event.overallScore === "number"
          ? ` score=${formatScore(event.overallScore)}`
          : ""
      }`,
    );
    return;
  }
  if (event.kind === "scenario_error") {
    console.error(
      `${prefix}ERROR ${label}: ${event.error?.message ?? "unknown error"}`,
    );
  }
}

function printRunSummary(result: RunResult): void {
  for (const scenarioResult of result.results) {
    console.log(
      `${scenarioResult.passed ? "PASS" : "FAIL"} ${scenarioResult.scenarioId} score=${formatScore(scenarioResult.overallScore)}`,
    );
  }
  const passedCount = result.results.filter((item) => item.passed).length;
  const failedCount = result.results.length - passedCount;
  console.log(
    `Summary: ${passedCount} passed, ${failedCount} failed, ${result.results.length} total`,
  );
}

function parseFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function parseIntegerValue(name: string, value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || String(parsed) !== value.trim()) {
    throw new AgentProbeConfigError(`${name} requires an integer value.`);
  }
  return parsed;
}

function parseOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

function parseIntegerOption(args: string[], name: string): number | undefined {
  const value = parseOption(args, name);
  if (value === undefined) {
    return undefined;
  }
  return parseIntegerValue(name, value);
}

function parseParallelOption(args: string[]): {
  enabled: boolean;
  limit?: number;
} {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg !== "--parallel" && arg !== "--parrallel") {
      continue;
    }

    const rawLimit = args[index + 1];
    if (rawLimit === undefined || rawLimit.startsWith("--")) {
      return { enabled: true };
    }

    const limit = parseIntegerValue("--parallel", rawLimit);
    if (limit < 1) {
      throw new AgentProbeConfigError(
        "--parallel must be at least 1 when a limit is provided.",
      );
    }
    return { enabled: true, limit };
  }

  return { enabled: false };
}

function normalizeGlobalArgs(argv: string[]): GlobalCliOptions {
  const args: string[] = [];
  let dataPath: string | undefined;
  let verbosity = 0;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--data-path") {
      dataPath = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "-vv") {
      verbosity = Math.max(verbosity, 2);
      continue;
    }
    if (arg === "-v" || arg === "--verbose") {
      verbosity = Math.min(2, verbosity + 1);
      continue;
    }
    args.push(arg);
  }

  return {
    args,
    dataPath,
    verbosity: verbosity >= 2 ? 2 : verbosity === 1 ? 1 : 0,
  };
}

function applyVerbosityLevel(verbosity: 0 | 1 | 2): void {
  if (verbosity >= 2) {
    setLogLevel("debug");
    return;
  }
  if (verbosity === 1) {
    setLogLevel("info");
    return;
  }
  setLogLevel("warn");
}

function selectDashboardScenarios(options: {
  scenariosPath: string;
  scenarioId?: string;
  tags?: string;
  repeat?: number;
}): DashboardScenarioSeed[] {
  const scenarioCollection = parseScenariosInput(options.scenariosPath);
  const requestedTags = new Set(
    (options.tags ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
  const requestedScenarioIds = options.scenarioId
    ? new Set(
        options.scenarioId
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
      )
    : undefined;
  const selectedScenarios = scenarioCollection.scenarios.filter((scenario) => {
    if (
      requestedScenarioIds &&
      !requestedScenarioIds.has(scenario.id) &&
      !requestedScenarioIds.has(scenario.name)
    ) {
      return false;
    }
    if (
      requestedTags.size > 0 &&
      !scenario.tags.some((tag) => requestedTags.has(tag))
    ) {
      return false;
    }
    return true;
  });
  const repeat = Math.max(1, options.repeat ?? 1);
  let ordinal = 0;
  return selectedScenarios.flatMap((scenario) =>
    Array.from({ length: repeat }, (_unused, iterationIndex) => {
      const iteration = iterationIndex + 1;
      const seed = {
        ordinal,
        displayId: iteration > 1 ? `${scenario.id}#${iteration}` : scenario.id,
        scenarioName: scenario.name,
      };
      ordinal += 1;
      return seed;
    }),
  );
}

async function bestEffortOpenBrowser(url: string): Promise<void> {
  if (Bun.env.AGENTPROBE_DISABLE_BROWSER_OPEN === "1") {
    return;
  }

  const command =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  try {
    const child = Bun.spawn({
      cmd: command,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    void child.exited.catch(() => {});
  } catch {}
}

async function handleValidate(
  args: string[],
  globalDataPath?: string,
): Promise<number> {
  const dataPath = parseOption(args, "--data-path") ?? globalDataPath ?? "data";
  console.log("Processed YAML files:");
  for (const item of processYamlFiles(dataPath)) {
    console.log(`- ${item.path}: ${item.schema} (${item.objectCount} objects)`);
  }
  return 0;
}

async function handleRun(args: string[]): Promise<number> {
  const endpoint = parseOption(args, "--endpoint");
  const scenarios = parseOption(args, "--scenarios");
  const personas = parseOption(args, "--personas");
  const rubric = parseOption(args, "--rubric");
  if (!endpoint || !scenarios || !personas || !rubric) {
    throw new AgentProbeConfigError(
      "run requires --endpoint, --scenarios, --personas, and --rubric.",
    );
  }

  const scenarioId =
    parseOption(args, "--scenario") ?? parseOption(args, "--scenario-id");

  const client = new OpenAiResponsesClient();
  client.assertConfigured();
  const recorder = new SqliteRunRecorder(
    suiteDbUrl([endpoint, scenarios, personas, rubric]),
  );
  const repeat = parseIntegerOption(args, "--repeat");
  if (repeat !== undefined && repeat < 1) {
    throw new AgentProbeConfigError("--repeat must be at least 1.");
  }

  const dashboardEnabled = parseFlag(args, "--dashboard");
  const dashboard = dashboardEnabled
    ? startDashboardServer({ dbUrl: recorder.dbUrl })
    : undefined;
  const parallel = parseParallelOption(args);

  try {
    if (dashboard) {
      dashboard.state.primeScenarios(
        selectDashboardScenarios({
          scenariosPath: scenarios,
          scenarioId,
          tags: parseOption(args, "--tags"),
          repeat,
        }),
      );
      console.error(`Dashboard: ${dashboard.url}`);
      void bestEffortOpenBrowser(dashboard.url);
    }

    const result = await runSuite({
      endpoint,
      scenarios,
      personas,
      rubric,
      scenarioId,
      tags: parseOption(args, "--tags"),
      client,
      recorder,
      progressCallback: (event) => {
        dashboard?.state.handleProgress(event);
        printRunProgress(event);
      },
      parallel: parallel.enabled,
      parallelLimit: parallel.limit,
      dryRun: parseFlag(args, "--dry-run"),
      repeat,
    });
    printRunSummary(result);
    return result.exitCode;
  } finally {
    dashboard?.stop();
  }
}

async function handleList(
  args: string[],
  globalDataPath?: string,
): Promise<number> {
  const scenariosPath =
    parseOption(args, "--scenarios") ?? globalDataPath ?? "data";
  const tags = parseOption(args, "--tags");
  const scenarioCollection = parseScenariosInput(scenariosPath);

  const requestedTags = new Set(
    (tags ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );

  const selectedScenarios = scenarioCollection.scenarios.filter((scenario) => {
    if (
      requestedTags.size > 0 &&
      !scenario.tags.some((tag) => requestedTags.has(tag))
    ) {
      return false;
    }
    return true;
  });

  if (selectedScenarios.length === 0) {
    console.error("No scenarios found.");
    return 1;
  }

  for (const scenario of selectedScenarios) {
    const tagSuffix =
      scenario.tags.length > 0 ? ` [${scenario.tags.join(", ")}]` : "";
    console.log(`${scenario.id}: ${scenario.name}${tagSuffix}`);
  }
  return 0;
}

async function handleReport(
  args: string[],
  globalDataPath?: string,
): Promise<number> {
  const written = writeRunReport({
    runId: parseOption(args, "--run-id"),
    dbUrl: dbUrlFromPath(parseOption(args, "--db-path")),
    outputPath: parseOption(args, "--output"),
    searchRoot: globalDataPath,
  });
  console.log(written);
  return 0;
}

async function handleOpenclaw(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  const endpointPath =
    parseOption(rest, "--endpoint") ?? "data/openclaw-endpoints.yaml";
  const endpoint = loadConfiguredEndpoint(endpointPath);

  if (subcommand === "create-session") {
    const client = new OpenClawGatewayClient(endpoint);
    await client.connect();
    try {
      const session = await client.createSession({
        key: parseOption(rest, "--session-key"),
        label: parseOption(rest, "--label"),
      });
      console.log(JSON.stringify(session, null, 2));
      return 0;
    } finally {
      await client.close();
    }
  }

  if (subcommand === "chat") {
    const message = parseOption(rest, "--message");
    if (!message) {
      throw new AgentProbeConfigError("openclaw chat requires --message.");
    }
    const result = await openclawChat(endpoint, {
      message,
      sessionKey: parseOption(rest, "--session-key"),
      label: parseOption(rest, "--label"),
      thinking: parseOption(rest, "--thinking"),
      waitForReply: !parseFlag(rest, "--no-wait"),
      timeoutMs: Number(parseOption(rest, "--timeout-ms") ?? "30000"),
    });
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  if (subcommand === "history") {
    const sessionKey = parseOption(rest, "--session-key");
    if (!sessionKey) {
      throw new AgentProbeConfigError(
        "openclaw history requires --session-key.",
      );
    }
    const history = await openclawHistory(endpoint, {
      sessionKey,
      limit: Number(parseOption(rest, "--limit") ?? "200"),
    });
    console.log(JSON.stringify(history, null, 2));
    return 0;
  }

  throw new AgentProbeConfigError(
    `Unknown openclaw subcommand: ${subcommand ?? ""}`,
  );
}

async function handleDbMigrate(args: string[]): Promise<number> {
  const dbFlag = parseOption(args, "--db");
  const envUrl = process.env.AGENTPROBE_DB_URL;
  let resolvedUrl: string;
  if (dbFlag) {
    if (
      dbFlag.startsWith("sqlite://") ||
      dbFlag.startsWith("postgres://") ||
      dbFlag.startsWith("postgresql://")
    ) {
      resolvedUrl = dbFlag;
    } else {
      resolvedUrl = `sqlite:///${resolve(dbFlag)}`;
    }
  } else if (envUrl) {
    resolvedUrl = envUrl;
  } else {
    resolvedUrl = `sqlite:///${resolve(DEFAULT_DB_DIRNAME, DEFAULT_DB_FILENAME)}`;
  }

  // Validate the URL scheme with a clear error before doing work.
  parseDbUrl(resolvedUrl);

  const report = await runMigrations(resolvedUrl);
  console.log(`backend: ${report.backend}`);
  console.log(`db_url:  ${report.dbUrl}`);
  console.log(`current: ${report.currentVersion}`);
  console.log(`target:  ${report.targetVersion}`);
  console.log(
    `applied: ${report.applied.length === 0 ? "(none)" : report.applied.join(",")}`,
  );
  return 0;
}

async function handleStartServer(
  args: string[],
  globalDataPath?: string,
): Promise<number> {
  const effectiveArgs = [...args];
  if (globalDataPath && !effectiveArgs.includes("--data")) {
    effectiveArgs.push("--data", globalDataPath);
  }
  const config = buildServerConfig({
    args: effectiveArgs,
    env: process.env as Record<string, string | undefined>,
  });
  const server = await startAgentProbeServer(config);
  console.error(`AgentProbe server listening on ${server.url}`);
  console.error(`  data:      ${config.dataPath}`);
  console.error(
    `  db_url:    ${config.dbUrl ? redactDbUrl(config.dbUrl) : "(none)"}`,
  );
  console.error(
    `  token:     ${config.token ? "set" : "(none)"}${
      config.unsafeExpose ? " (unsafe-expose)" : ""
    }`,
  );
  if (config.openBrowser) {
    void bestEffortOpenBrowser(server.url);
  }

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.error(`\nReceived ${signal}; shutting down.`);
    await server.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  return await new Promise<number>(() => {
    // Resolves only on signal-driven shutdown.
  });
}

export async function executeCli(argv: string[]): Promise<number> {
  const normalized = normalizeGlobalArgs(argv);
  applyVerbosityLevel(normalized.verbosity);
  const args = normalized.args;
  const globalDataPath = normalized.dataPath;

  const [command = "validate", ...rest] = args;

  try {
    if (command === "validate") {
      return await handleValidate(rest, globalDataPath);
    }
    if (command === "list") {
      return await handleList(rest, globalDataPath);
    }
    if (command === "run") {
      return await handleRun(rest);
    }
    if (command === "report") {
      return await handleReport(rest, globalDataPath);
    }
    if (command === "openclaw") {
      return await handleOpenclaw(rest);
    }
    if (command === "start-server") {
      return await handleStartServer(rest, globalDataPath);
    }
    if (command === "db:migrate") {
      return await handleDbMigrate(rest);
    }
    throw new AgentProbeConfigError(`Unknown command: ${command}`);
  } catch (error) {
    if (error instanceof AgentProbeConfigError) {
      console.error(`Configuration error: ${error.message}`);
      return 2;
    }
    if (error instanceof AgentProbeRuntimeError) {
      console.error(`Runtime error: ${error.message}`);
      return 3;
    }
    throw error;
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const exitCode = await executeCli(argv);
  process.exit(exitCode);
}

if (import.meta.main) {
  await main();
}

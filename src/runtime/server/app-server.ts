import type { Context } from "hono";
import { Hono } from "hono";

import { createRecordingRepository } from "../../providers/persistence/factory.ts";
import { resolveSqlitePath } from "../../providers/persistence/sqlite-connection.ts";
import type {
  PersistenceRepository,
  RecordingRepository,
} from "../../providers/persistence/types.ts";
import {
  AgentProbeConfigError,
  AgentProbeRuntimeError,
} from "../../shared/utils/errors.ts";
import {
  createSecretCipher,
  resolveMasterKey,
} from "../../shared/utils/secret-cipher.ts";
import type { ServerConfig } from "./config.ts";
import {
  type ComparisonController,
  createComparisonController,
} from "./controllers/comparison-controller.ts";
import { EndpointOverridesController } from "./controllers/endpoint-overrides-controller.ts";
import { PresetController } from "./controllers/preset-controller.ts";
import { RunController } from "./controllers/run-controller.ts";
import { SettingsController } from "./controllers/settings-controller.ts";
import { SuiteController } from "./controllers/suite-controller.ts";
import {
  logDefaultPresetSeedResults,
  seedDefaultPresets,
} from "./default-presets.ts";
import { ensureRequestId, errorResponse } from "./http-helpers.ts";
import {
  type PerfTracker,
  responseBudget,
} from "./middleware/response-budget.ts";
import { handleCompareRuns } from "./routes/comparisons.ts";
import {
  handleDeleteEndpointOverride,
  handleGetEndpointOverride,
  handleListEndpointOverrides,
  handlePutEndpointOverride,
} from "./routes/endpoint-overrides.ts";
import { handleHealthz, handleReadyz, handleSession } from "./routes/health.ts";
import {
  handleGetNextHumanScoringItem,
  handleListHumanScoringRubrics,
  handlePostHumanScore,
} from "./routes/human-scoring.ts";
import {
  handleCreatePreset,
  handleCreatePresetFromRun,
  handleDeletePreset,
  handleGetPreset,
  handleListPresets,
  handlePresetRuns,
  handleStartPresetRun,
  handleUpdatePreset,
} from "./routes/presets.ts";
import { handleRunReport } from "./routes/reports.ts";
import {
  handleCancelRun,
  handleGetRun,
  handleGetScenarioRun,
  handleListRuns,
  handlePatchRun,
  handleStartRun,
} from "./routes/runs.ts";
import {
  handleDeleteOpenRouterApiKey,
  handleGetOpenRouterStatus,
  handlePutOpenRouterApiKey,
} from "./routes/settings.ts";
import { handleRunSse } from "./routes/sse.ts";
import { handleStatic } from "./routes/static.ts";
import {
  handleListAllScenarios,
  handleListSuiteScenarios,
  handleListSuites,
  handleScenarioLookup,
} from "./routes/suites.ts";
import { StreamHub } from "./streams/hub.ts";

export const SERVER_VERSION = "0.1.0";

export type ServerContext = {
  config: ServerConfig;
  presetController: PresetController;
  runController: RunController;
  suiteController: SuiteController;
  comparisonController: ComparisonController;
  settingsController: SettingsController;
  endpointOverridesController: EndpointOverridesController;
  repository: PersistenceRepository;
  streamHub: StreamHub;
  requestId: string;
  startedAt: number;
  version: string;
};

export type StartedServer = {
  url: string;
  hostname: string;
  port: number;
  streamHub: StreamHub;
  suiteController: SuiteController;
  stop: () => Promise<void>;
};

type ServerContextBase = Omit<ServerContext, "requestId">;

type ServerHonoEnv = {
  Variables: {
    requestStartedAt: number;
    serverContext: ServerContext;
    perf: PerfTracker;
  };
};

function serverContext(c: Context<ServerHonoEnv>): ServerContext {
  return c.get("serverContext");
}

const GZIP_MIN_BYTES = 1024;
const GZIP_COMPRESSIBLE_TYPE = /^(application\/(json|javascript|xml)|text\/)/i;

/**
 * Bun.serve does not auto-compress responses. Run-detail payloads can be
 * many MB of JSON, so we gzip eligible responses here. SSE streams and
 * already-encoded responses pass through untouched.
 */
async function maybeGzip(
  request: Request,
  response: Response,
): Promise<Response> {
  if (!request.headers.get("accept-encoding")?.toLowerCase().includes("gzip")) {
    return response;
  }
  if (!response.body || response.status === 204 || response.status === 304) {
    return response;
  }
  if (response.headers.get("content-encoding")) {
    return response;
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!GZIP_COMPRESSIBLE_TYPE.test(contentType)) {
    return response;
  }
  if (contentType.toLowerCase().includes("text/event-stream")) {
    return response;
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength < GZIP_MIN_BYTES) {
    const headers = new Headers(response.headers);
    headers.append("vary", "Accept-Encoding");
    return new Response(buffer, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
  const compressed = Bun.gzipSync(new Uint8Array(buffer));
  const headers = new Headers(response.headers);
  headers.set("content-encoding", "gzip");
  headers.set("content-length", String(compressed.byteLength));
  headers.append("vary", "Accept-Encoding");
  return new Response(compressed, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function logRequest(
  config: ServerConfig,
  request: Request,
  response: Response,
  durationMs: number,
  requestId: string,
): void {
  const pathname = new URL(request.url).pathname;
  if (config.logFormat === "json") {
    const payload = {
      ts: new Date().toISOString(),
      level: "info",
      component: "agentprobe.server",
      method: request.method,
      path: pathname,
      status: response.status,
      duration_ms: Math.round(durationMs),
      request_id: requestId,
    };
    process.stderr.write(`${JSON.stringify(payload)}\n`);
    return;
  }
  process.stderr.write(
    `[server] ${request.method} ${pathname} -> ${response.status} (${durationMs.toFixed(
      1,
    )}ms) rid=${requestId}\n`,
  );
}

function serverErrorResponse(error: unknown, requestId: string): Response {
  if (error instanceof AgentProbeConfigError) {
    return errorResponse({
      status: 400,
      type: "ConfigurationError",
      message: error.message,
      requestId,
    });
  }
  if (error instanceof AgentProbeRuntimeError) {
    return errorResponse({
      status: 500,
      type: "RuntimeError",
      message: error.message,
      requestId,
    });
  }
  return errorResponse({
    status: 500,
    type: "InternalServerError",
    message: error instanceof Error ? error.message : String(error),
    requestId,
  });
}

function createServerApp(
  config: ServerConfig,
  baseContext: ServerContextBase,
): Hono<ServerHonoEnv> {
  const app = new Hono<ServerHonoEnv>();

  app.use("*", async (c, next) => {
    const requestId = ensureRequestId(c.req.raw);
    c.set("requestStartedAt", performance.now());
    c.set("serverContext", { ...baseContext, requestId });
    await next();
    const finalResponse = await maybeGzip(c.req.raw, c.res);
    logRequest(
      config,
      c.req.raw,
      finalResponse,
      performance.now() - c.get("requestStartedAt"),
      requestId,
    );
    c.res = finalResponse;
  });

  app.use(
    "*",
    responseBudget({
      skip: (path) => path.endsWith("/events") || path.endsWith("/report.html"),
    }),
  );

  app.onError((error, c) =>
    serverErrorResponse(error, serverContext(c).requestId),
  );

  app.get("/healthz", (c) => handleHealthz(c.req.raw, serverContext(c)));
  app.get("/readyz", (c) => handleReadyz(c.req.raw, serverContext(c)));
  app.get("/api/session", (c) => handleSession(c.req.raw, serverContext(c)));
  app.get("/api/suites", (c) => handleListSuites(c.req.raw, serverContext(c)));
  app.get("/api/suites/:suiteId/scenarios", (c) =>
    handleListSuiteScenarios(c.req.raw, serverContext(c), {
      suiteId: c.req.param("suiteId"),
    }),
  );
  app.get("/api/scenarios", (c) =>
    handleListAllScenarios(c.req.raw, serverContext(c)),
  );
  app.get("/api/scenarios/lookup", (c) =>
    handleScenarioLookup(c.req.raw, serverContext(c)),
  );

  app.get("/api/runs", (c) => handleListRuns(c.req.raw, serverContext(c)));
  app.post("/api/runs", (c) => handleStartRun(c.req.raw, serverContext(c)));
  app.get("/api/runs/:runId", (c) =>
    handleGetRun(c.req.raw, serverContext(c), {
      runId: c.req.param("runId"),
    }),
  );
  app.patch("/api/runs/:runId", (c) =>
    handlePatchRun(c.req.raw, serverContext(c), {
      runId: c.req.param("runId"),
    }),
  );
  app.post("/api/runs/:runId/cancel", (c) =>
    handleCancelRun(c.req.raw, serverContext(c), {
      runId: c.req.param("runId"),
    }),
  );
  app.get("/api/runs/:runId/scenarios/:ordinal", (c) =>
    handleGetScenarioRun(c.req.raw, serverContext(c), {
      runId: c.req.param("runId"),
      ordinal: c.req.param("ordinal"),
    }),
  );
  app.get("/api/runs/:runId/events", (c) =>
    handleRunSse(c.req.raw, serverContext(c), {
      runId: c.req.param("runId"),
    }),
  );
  app.get("/api/runs/:runId/report.html", (c) =>
    handleRunReport(c.req.raw, serverContext(c), {
      runId: c.req.param("runId"),
    }),
  );
  app.post("/api/runs/:runId/save-as-preset", (c) =>
    handleCreatePresetFromRun(c.req.raw, serverContext(c), {
      runId: c.req.param("runId"),
    }),
  );

  app.get("/api/comparisons", (c) =>
    handleCompareRuns(c.req.raw, serverContext(c)),
  );

  app.get("/api/human-scoring/rubrics", (c) =>
    handleListHumanScoringRubrics(c.req.raw, serverContext(c)),
  );
  app.get("/api/human-scoring/next", (c) =>
    handleGetNextHumanScoringItem(c.req.raw, serverContext(c)),
  );
  app.post("/api/human-scoring/scores", (c) =>
    handlePostHumanScore(c.req.raw, serverContext(c)),
  );

  app.get("/api/presets", (c) =>
    handleListPresets(c.req.raw, serverContext(c)),
  );
  app.post("/api/presets", (c) =>
    handleCreatePreset(c.req.raw, serverContext(c)),
  );
  app.get("/api/presets/:presetId", (c) =>
    handleGetPreset(c.req.raw, serverContext(c), {
      presetId: c.req.param("presetId"),
    }),
  );
  app.put("/api/presets/:presetId", (c) =>
    handleUpdatePreset(c.req.raw, serverContext(c), {
      presetId: c.req.param("presetId"),
    }),
  );
  app.delete("/api/presets/:presetId", (c) =>
    handleDeletePreset(c.req.raw, serverContext(c), {
      presetId: c.req.param("presetId"),
    }),
  );
  app.get("/api/presets/:presetId/runs", (c) =>
    handlePresetRuns(c.req.raw, serverContext(c), {
      presetId: c.req.param("presetId"),
    }),
  );
  app.post("/api/presets/:presetId/runs", (c) =>
    handleStartPresetRun(c.req.raw, serverContext(c), {
      presetId: c.req.param("presetId"),
    }),
  );

  app.get("/api/settings/secrets/open_router_api_key", (c) =>
    handleGetOpenRouterStatus(c.req.raw, serverContext(c)),
  );
  app.put("/api/settings/secrets/open_router_api_key", (c) =>
    handlePutOpenRouterApiKey(c.req.raw, serverContext(c)),
  );
  app.delete("/api/settings/secrets/open_router_api_key", (c) =>
    handleDeleteOpenRouterApiKey(c.req.raw, serverContext(c)),
  );

  app.get("/api/endpoint-overrides", (c) =>
    handleListEndpointOverrides(c.req.raw, serverContext(c)),
  );
  app.get("/api/endpoint-overrides/:endpointPath", (c) =>
    handleGetEndpointOverride(c.req.raw, serverContext(c), {
      endpointPath: c.req.param("endpointPath"),
    }),
  );
  app.put("/api/endpoint-overrides/:endpointPath", (c) =>
    handlePutEndpointOverride(c.req.raw, serverContext(c), {
      endpointPath: c.req.param("endpointPath"),
    }),
  );
  app.delete("/api/endpoint-overrides/:endpointPath", (c) =>
    handleDeleteEndpointOverride(c.req.raw, serverContext(c), {
      endpointPath: c.req.param("endpointPath"),
    }),
  );

  app.notFound((c) => handleStatic(c.req.raw, serverContext(c)));

  return app;
}

export async function startAgentProbeServer(
  config: ServerConfig,
): Promise<StartedServer> {
  const repository: RecordingRepository = createRecordingRepository(
    config.dbUrl,
  );
  await repository.initialize();

  const masterKey = resolveMasterKey({
    backendKind: repository.kind,
    sqlitePath:
      repository.kind === "sqlite"
        ? resolveSqlitePath(config.dbUrl)
        : undefined,
  });
  const cipher = createSecretCipher(masterKey);
  const settingsController = new SettingsController({ repository, cipher });

  const suiteController = new SuiteController({ dataPath: config.dataPath });
  // Warm cache and surface directory errors early.
  suiteController.inventory();
  logDefaultPresetSeedResults(
    await seedDefaultPresets({ repository, suiteController }),
    { logFormat: config.logFormat },
  );

  const streamHub = new StreamHub();
  const presetController = new PresetController({
    repository,
    suiteController,
  });
  const endpointOverridesController = new EndpointOverridesController({
    repository,
    suiteController,
  });
  const runController = new RunController({
    repository,
    suiteController,
    streamHub,
    settingsController,
    endpointOverridesController,
  });
  const comparisonController = createComparisonController({
    repository,
    categoryLookup: (scenarioId, fileHint) => {
      if (fileHint) {
        const direct = suiteController.scenarioRecord(fileHint, scenarioId);
        if (direct?.category) return direct.category;
      }
      for (const summary of suiteController.scenarios()) {
        if (summary.id !== scenarioId) continue;
        const record = suiteController.scenarioRecord(
          summary.sourcePath,
          scenarioId,
        );
        if (record?.category) return record.category;
      }
      return null;
    },
  });
  const startedAt = Date.now();

  const baseContext: ServerContextBase = {
    config,
    presetController,
    runController,
    suiteController,
    comparisonController,
    settingsController,
    endpointOverridesController,
    repository,
    streamHub,
    startedAt,
    version: SERVER_VERSION,
  };
  const app = createServerApp(config, baseContext);

  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    fetch: app.fetch,
  });

  const stop = async (): Promise<void> => {
    await runController.cancelAllAndWait(5_000);
    server.stop(true);
    await repository.close?.();
  };

  const hostname = server.hostname ?? config.host;
  const port = server.port ?? config.port;
  const url = `http://${hostname}:${port}`;

  return {
    url,
    hostname,
    port,
    streamHub,
    suiteController,
    stop,
  };
}

import { createRecordingRepository } from "../../providers/persistence/factory.ts";
import type {
  PersistenceRepository,
  RecordingRepository,
} from "../../providers/persistence/types.ts";
import {
  AgentProbeConfigError,
  AgentProbeRuntimeError,
} from "../../shared/utils/errors.ts";
import { verifyBearerToken } from "./auth/token.ts";
import type { ServerConfig } from "./config.ts";
import {
  type ComparisonController,
  createComparisonController,
} from "./controllers/comparison-controller.ts";
import { PresetController } from "./controllers/preset-controller.ts";
import { RunController } from "./controllers/run-controller.ts";
import { SuiteController } from "./controllers/suite-controller.ts";
import { ensureRequestId, errorResponse } from "./http-helpers.ts";
import {
  createObservability,
  type Logger,
  METRIC_NAMES,
  type Observability,
  summarizeServerConfig,
} from "./observability/index.ts";
import { handleCompareRuns } from "./routes/comparisons.ts";
import { handleHealthz, handleReadyz, handleSession } from "./routes/health.ts";
import {
  handleCreatePreset,
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
  handleStartRun,
} from "./routes/runs.ts";
import { handleRunSse } from "./routes/sse.ts";
import { handleStatic } from "./routes/static.ts";
import {
  handleListAllScenarios,
  handleListSuiteScenarios,
  handleListSuites,
} from "./routes/suites.ts";
import { StreamHub } from "./streams/hub.ts";

export const SERVER_VERSION = "0.1.0";
const CORS_ALLOW_METHODS = "GET, POST, PUT, DELETE, OPTIONS";
const CORS_ALLOW_HEADERS = "authorization, content-type, x-request-id";
const CORS_MAX_AGE_SECONDS = "600";

export type ServerContext = {
  config: ServerConfig;
  presetController: PresetController;
  runController: RunController;
  suiteController: SuiteController;
  comparisonController: ComparisonController;
  repository: PersistenceRepository;
  streamHub: StreamHub;
  observability: Observability;
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
  observability: Observability;
  stop: () => Promise<void>;
};

type RouteHandler = (
  request: Request,
  context: ServerContext,
  params: Record<string, string>,
) => Response | Promise<Response>;

type Route = {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
  requiresAuth: boolean;
};

function compileRoute(
  method: string,
  path: string,
  handler: RouteHandler,
  options: { requiresAuth?: boolean } = {},
): Route {
  const paramNames: string[] = [];
  const regexSource = path.replace(/:([a-zA-Z_]+)/g, (_match, name: string) => {
    paramNames.push(name);
    return "([^/]+)";
  });
  return {
    method,
    pattern: new RegExp(`^${regexSource}$`),
    paramNames,
    handler,
    requiresAuth: options.requiresAuth ?? method !== "OPTIONS",
  };
}

function buildRoutes(): Route[] {
  return [
    compileRoute("GET", "/healthz", handleHealthz, { requiresAuth: false }),
    compileRoute("GET", "/readyz", handleReadyz, { requiresAuth: false }),
    compileRoute("GET", "/api/session", handleSession, { requiresAuth: false }),
    compileRoute("GET", "/api/suites", handleListSuites),
    compileRoute(
      "GET",
      "/api/suites/:suiteId/scenarios",
      (request, context, params) =>
        handleListSuiteScenarios(request, context, {
          suiteId: params.suiteId ?? "",
        }),
    ),
    compileRoute("GET", "/api/scenarios", handleListAllScenarios),
    compileRoute("GET", "/api/runs", handleListRuns),
    compileRoute("POST", "/api/runs", handleStartRun),
    compileRoute("GET", "/api/runs/:runId", (request, context, params) =>
      handleGetRun(request, context, { runId: params.runId ?? "" }),
    ),
    compileRoute(
      "POST",
      "/api/runs/:runId/cancel",
      (request, context, params) =>
        handleCancelRun(request, context, { runId: params.runId ?? "" }),
    ),
    compileRoute(
      "GET",
      "/api/runs/:runId/scenarios/:ordinal",
      (request, context, params) =>
        handleGetScenarioRun(request, context, {
          runId: params.runId ?? "",
          ordinal: params.ordinal ?? "",
        }),
    ),
    compileRoute("GET", "/api/runs/:runId/events", (request, context, params) =>
      handleRunSse(request, context, { runId: params.runId ?? "" }),
    ),
    compileRoute(
      "GET",
      "/api/runs/:runId/report.html",
      (request, context, params) =>
        handleRunReport(request, context, { runId: params.runId ?? "" }),
    ),
    compileRoute("GET", "/api/comparisons", (request, context) =>
      handleCompareRuns(request, context),
    ),
    compileRoute("GET", "/api/presets", handleListPresets),
    compileRoute("POST", "/api/presets", handleCreatePreset),
    compileRoute("GET", "/api/presets/:presetId", (request, context, params) =>
      handleGetPreset(request, context, { presetId: params.presetId ?? "" }),
    ),
    compileRoute("PUT", "/api/presets/:presetId", (request, context, params) =>
      handleUpdatePreset(request, context, {
        presetId: params.presetId ?? "",
      }),
    ),
    compileRoute(
      "DELETE",
      "/api/presets/:presetId",
      (request, context, params) =>
        handleDeletePreset(request, context, {
          presetId: params.presetId ?? "",
        }),
    ),
    compileRoute(
      "GET",
      "/api/presets/:presetId/runs",
      (request, context, params) =>
        handlePresetRuns(request, context, { presetId: params.presetId ?? "" }),
    ),
    compileRoute(
      "POST",
      "/api/presets/:presetId/runs",
      (request, context, params) =>
        handleStartPresetRun(request, context, {
          presetId: params.presetId ?? "",
        }),
    ),
  ];
}

function matchRoute(
  routes: Route[],
  method: string,
  pathname: string,
): { route: Route; params: Record<string, string> } | undefined {
  for (const route of routes) {
    if (route.method !== method && route.method !== "*") {
      continue;
    }
    const match = route.pattern.exec(pathname);
    if (!match) {
      continue;
    }
    const params: Record<string, string> = {};
    route.paramNames.forEach((name, index) => {
      params[name] = match[index + 1] ?? "";
    });
    return { route, params };
  }
  return undefined;
}

function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  if (normalized === "localhost" || normalized === "::1") {
    return true;
  }
  const parts = normalized.split(".");
  if (parts.length !== 4 || parts[0] !== "127") {
    return false;
  }
  return parts.every((part) => {
    if (!/^\d+$/.test(part)) {
      return false;
    }
    const value = Number(part);
    return Number.isInteger(value) && value >= 0 && value <= 255;
  });
}

function loopbackOriginsFor(url: URL): Set<string> {
  const origins = new Set<string>([url.origin]);
  if (!isLoopbackHostname(url.hostname)) {
    return origins;
  }
  const port = url.port ? `:${url.port}` : "";
  origins.add(`${url.protocol}//localhost${port}`);
  origins.add(`${url.protocol}//127.0.0.1${port}`);
  origins.add(`${url.protocol}//[::1]${port}`);
  return origins;
}

function normalizedOrigin(raw: string): string | undefined {
  try {
    return new URL(raw).origin;
  } catch {
    return undefined;
  }
}

function allowedCorsOrigin(
  request: Request,
  config: ServerConfig,
): string | undefined {
  const requestUrl = new URL(request.url);
  const origin = request.headers.get("origin");
  if (!origin) {
    return config.corsOrigins[0] ?? requestUrl.origin;
  }

  const normalized = normalizedOrigin(origin);
  if (!normalized) {
    return undefined;
  }

  if (config.corsOrigins.length > 0) {
    return config.corsOrigins.includes(normalized) ? normalized : undefined;
  }
  return loopbackOriginsFor(requestUrl).has(normalized)
    ? normalized
    : undefined;
}

function corsHeaders(
  request: Request,
  config: ServerConfig,
): Headers | undefined {
  const allowOrigin = allowedCorsOrigin(request, config);
  if (!allowOrigin) {
    return undefined;
  }
  const headers = new Headers();
  headers.set("access-control-allow-origin", allowOrigin);
  headers.set("access-control-allow-credentials", "true");
  headers.set("vary", "Origin");
  return headers;
}

function preflightResponse(request: Request, config: ServerConfig): Response {
  const headers = corsHeaders(request, config);
  if (!headers) {
    return new Response(null, {
      status: 403,
      headers: { vary: "Origin" },
    });
  }
  headers.set("access-control-allow-methods", CORS_ALLOW_METHODS);
  headers.set(
    "access-control-allow-headers",
    request.headers.get("access-control-request-headers") ?? CORS_ALLOW_HEADERS,
  );
  headers.set("access-control-max-age", CORS_MAX_AGE_SECONDS);
  return new Response(null, {
    status: 204,
    headers,
  });
}

function withCorsHeaders(
  request: Request,
  config: ServerConfig,
  response: Response,
): Response {
  const headers = new Headers(response.headers);
  const cors = corsHeaders(request, config);
  if (cors) {
    for (const [name, value] of cors) {
      headers.set(name, value);
    }
  } else if (request.headers.has("origin")) {
    headers.append("vary", "Origin");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function logRequest(
  logger: Logger,
  request: Request,
  response: Response,
  durationMs: number,
  requestId: string,
  matchedRoute: string | undefined,
): void {
  const pathname = new URL(request.url).pathname;
  logger.info("http.request", {
    method: request.method,
    path: pathname,
    route: matchedRoute ?? null,
    status: response.status,
    duration_ms: Math.round(durationMs),
    request_id: requestId,
  });
}

export type StartAgentProbeServerOptions = {
  observability?: Observability;
};

export async function startAgentProbeServer(
  config: ServerConfig,
  options: StartAgentProbeServerOptions = {},
): Promise<StartedServer> {
  const observability =
    options.observability ?? createObservability({ format: config.logFormat });
  const { logger, metrics } = observability;

  const repository: RecordingRepository = createRecordingRepository(
    config.dbUrl,
  );
  await repository.initialize();

  const suiteController = new SuiteController({ dataPath: config.dataPath });
  // Warm cache and surface directory errors early.
  suiteController.inventory();

  const streamHub = new StreamHub();
  const presetController = new PresetController({
    repository,
    suiteController,
  });
  const runController = new RunController({
    repository,
    suiteController,
    streamHub,
    observability,
  });
  const comparisonController = createComparisonController({ repository });
  const routes = buildRoutes();
  const startedAt = Date.now();

  logger.info("server.startup", {
    version: SERVER_VERSION,
    config: summarizeServerConfig(config),
  });
  metrics.setGauge(METRIC_NAMES.runsActive, 0);
  metrics.setGauge(METRIC_NAMES.sseConnections, 0);

  const baseContext = {
    config,
    presetController,
    runController,
    suiteController,
    comparisonController,
    repository,
    streamHub,
    observability,
    startedAt,
    version: SERVER_VERSION,
  };

  const fetchHandler = async (request: Request): Promise<Response> => {
    const requestId = ensureRequestId(request);
    const url = new URL(request.url);
    const t0 = performance.now();
    let response: Response;
    let routeLabel: string | undefined;
    const context: ServerContext = { ...baseContext, requestId };
    try {
      if (request.method === "OPTIONS" && isApiPath(url.pathname)) {
        response = preflightResponse(request, config);
        routeLabel = "OPTIONS";
      } else {
        const matched = matchRoute(routes, request.method, url.pathname);
        if (matched) {
          routeLabel = matched.route.pattern.source;
          if (matched.route.requiresAuth && config.token) {
            if (!verifyBearerToken(request, config.token)) {
              response = errorResponse({
                status: 401,
                type: "Unauthorized",
                message: "Missing or invalid bearer token.",
                requestId,
                headers: { "www-authenticate": 'Bearer realm="agentprobe"' },
              });
            } else {
              response = await matched.route.handler(
                request,
                context,
                matched.params,
              );
            }
          } else {
            response = await matched.route.handler(
              request,
              context,
              matched.params,
            );
          }
        } else {
          response = await handleStatic(request, context);
        }
      }
    } catch (error) {
      if (error instanceof AgentProbeConfigError) {
        response = errorResponse({
          status: 400,
          type: "ConfigurationError",
          message: error.message,
          requestId,
        });
      } else if (error instanceof AgentProbeRuntimeError) {
        response = errorResponse({
          status: 500,
          type: "RuntimeError",
          message: error.message,
          requestId,
        });
      } else {
        response = errorResponse({
          status: 500,
          type: "InternalServerError",
          message: error instanceof Error ? error.message : String(error),
          requestId,
        });
      }
    }

    if (isApiPath(url.pathname) && request.method !== "OPTIONS") {
      response = withCorsHeaders(request, config, response);
    }

    const duration = performance.now() - t0;
    logRequest(logger, request, response, duration, requestId, routeLabel);
    metrics.incrementCounter(METRIC_NAMES.httpRequests, 1, {
      method: request.method,
      route: routeLabel ?? "unmatched",
      status: response.status,
    });
    return response;
  };

  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    fetch: fetchHandler,
  });

  const stop = async (): Promise<void> => {
    await runController.cancelAllAndWait(5_000);
    server.stop(true);
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
    observability,
    stop,
  };
}

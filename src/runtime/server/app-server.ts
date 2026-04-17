import { initDb } from "../../providers/persistence/sqlite-run-history.ts";
import {
  AgentProbeConfigError,
  AgentProbeRuntimeError,
} from "../../shared/utils/errors.ts";
import { verifyBearerToken } from "./auth/token.ts";
import type { ServerConfig } from "./config.ts";
import { SuiteController } from "./controllers/suite-controller.ts";
import { ensureRequestId, errorResponse } from "./http-helpers.ts";
import { handleHealthz, handleReadyz } from "./routes/health.ts";
import { handleRunReport } from "./routes/reports.ts";
import {
  handleGetRun,
  handleGetScenarioRun,
  handleListRuns,
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

export type ServerContext = {
  config: ServerConfig;
  suiteController: SuiteController;
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
    compileRoute("GET", "/api/runs/:runId", (request, context, params) =>
      handleGetRun(request, context, { runId: params.runId ?? "" }),
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

export async function startAgentProbeServer(
  config: ServerConfig,
): Promise<StartedServer> {
  if (config.dbUrl) {
    if (
      config.dbUrl.startsWith("postgres://") ||
      config.dbUrl.startsWith("postgresql://")
    ) {
      throw new AgentProbeConfigError(
        "Postgres is not yet supported; Phase 3 will introduce `postgres://` support.",
      );
    }
    initDb(config.dbUrl);
  }

  const suiteController = new SuiteController({ dataPath: config.dataPath });
  // Warm cache and surface directory errors early.
  suiteController.inventory();

  const streamHub = new StreamHub();
  const routes = buildRoutes();
  const startedAt = Date.now();

  const baseContext = {
    config,
    suiteController,
    streamHub,
    startedAt,
    version: SERVER_VERSION,
  };

  const fetchHandler = async (request: Request): Promise<Response> => {
    const requestId = ensureRequestId(request);
    const url = new URL(request.url);
    const t0 = performance.now();
    let response: Response;
    const context: ServerContext = { ...baseContext, requestId };
    try {
      const matched = matchRoute(routes, request.method, url.pathname);
      if (matched) {
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

    logRequest(config, request, response, performance.now() - t0, requestId);
    return response;
  };

  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    fetch: fetchHandler,
  });

  const stop = async (): Promise<void> => {
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
    stop,
  };
}

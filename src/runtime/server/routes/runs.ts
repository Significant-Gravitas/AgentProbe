import {
  getRun,
  listRuns,
} from "../../../providers/persistence/sqlite-run-history.ts";
import type { RunRecord, RunSummary } from "../../../shared/types/contracts.ts";
import type { ServerContext } from "../app-server.ts";
import {
  errorResponse,
  jsonResponse,
  parsePositiveInt,
} from "../http-helpers.ts";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

function filterRuns(
  runs: RunSummary[],
  filters: {
    status?: string | null;
    preset?: string | null;
    suiteFingerprint?: string | null;
  },
): RunSummary[] {
  return runs.filter((run) => {
    if (filters.status && run.status !== filters.status) {
      return false;
    }
    if (filters.preset && run.preset !== filters.preset) {
      return false;
    }
    if (
      filters.suiteFingerprint &&
      run.suiteFingerprint !== filters.suiteFingerprint
    ) {
      return false;
    }
    return true;
  });
}

export function handleListRuns(
  request: Request,
  context: ServerContext,
): Response {
  if (!context.config.dbUrl) {
    return jsonResponse(
      { runs: [], total: 0, next_cursor: null },
      { requestId: context.requestId },
    );
  }

  let allRuns: RunSummary[];
  try {
    allRuns = listRuns({ dbUrl: context.config.dbUrl });
  } catch (error) {
    return errorResponse({
      status: 500,
      type: "PersistenceError",
      message: error instanceof Error ? error.message : String(error),
      requestId: context.requestId,
    });
  }

  const url = new URL(request.url);
  const limit = parsePositiveInt(
    url.searchParams.get("limit"),
    DEFAULT_PAGE_SIZE,
    MAX_PAGE_SIZE,
  );
  const offset = parsePositiveInt(
    url.searchParams.get("offset"),
    0,
    Number.MAX_SAFE_INTEGER,
  );
  const status = url.searchParams.get("status");
  const preset = url.searchParams.get("preset");
  const suiteFingerprint = url.searchParams.get("suite_fingerprint");

  const filtered = filterRuns(allRuns, { status, preset, suiteFingerprint });
  const start = offset === 0 ? 0 : Math.min(offset, filtered.length);
  const page = filtered.slice(start, start + limit);
  const nextOffset = start + page.length;

  return jsonResponse(
    {
      runs: page,
      total: filtered.length,
      limit,
      offset: start,
      next_cursor: nextOffset < filtered.length ? String(nextOffset) : null,
    },
    { requestId: context.requestId },
  );
}

export function handleGetRun(
  _request: Request,
  context: ServerContext,
  params: { runId: string },
): Response {
  if (!context.config.dbUrl) {
    return errorResponse({
      status: 404,
      type: "NotFound",
      message: `Run \`${params.runId}\` was not found (no database configured).`,
      requestId: context.requestId,
    });
  }

  let run: RunRecord | undefined;
  try {
    run = getRun(params.runId, { dbUrl: context.config.dbUrl });
  } catch (error) {
    return errorResponse({
      status: 500,
      type: "PersistenceError",
      message: error instanceof Error ? error.message : String(error),
      requestId: context.requestId,
    });
  }
  if (!run) {
    return errorResponse({
      status: 404,
      type: "NotFound",
      message: `Run \`${params.runId}\` was not found.`,
      requestId: context.requestId,
    });
  }
  return jsonResponse({ run }, { requestId: context.requestId });
}

export function handleGetScenarioRun(
  _request: Request,
  context: ServerContext,
  params: { runId: string; ordinal: string },
): Response {
  if (!context.config.dbUrl) {
    return errorResponse({
      status: 404,
      type: "NotFound",
      message: `Run \`${params.runId}\` was not found (no database configured).`,
      requestId: context.requestId,
    });
  }

  const ordinal = Number(params.ordinal);
  if (!Number.isInteger(ordinal) || ordinal < 0) {
    return errorResponse({
      status: 400,
      type: "BadRequest",
      message: `Scenario ordinal must be a non-negative integer (got \`${params.ordinal}\`).`,
      requestId: context.requestId,
    });
  }

  let run: RunRecord | undefined;
  try {
    run = getRun(params.runId, { dbUrl: context.config.dbUrl });
  } catch (error) {
    return errorResponse({
      status: 500,
      type: "PersistenceError",
      message: error instanceof Error ? error.message : String(error),
      requestId: context.requestId,
    });
  }
  if (!run) {
    return errorResponse({
      status: 404,
      type: "NotFound",
      message: `Run \`${params.runId}\` was not found.`,
      requestId: context.requestId,
    });
  }
  const scenario = run.scenarios.find((item) => item.ordinal === ordinal);
  if (!scenario) {
    return errorResponse({
      status: 404,
      type: "NotFound",
      message: `Scenario ordinal ${ordinal} was not found for run \`${params.runId}\`.`,
      requestId: context.requestId,
    });
  }
  return jsonResponse(
    {
      run: {
        runId: run.runId,
        status: run.status,
        passed: run.passed,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
      },
      scenario,
    },
    { requestId: context.requestId },
  );
}

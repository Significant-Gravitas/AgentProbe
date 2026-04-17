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
import { HttpInputError } from "../validation.ts";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

function filterRuns(
  runs: RunSummary[],
  filters: {
    status?: string | null;
    preset?: string | null;
    presetId?: string | null;
    trigger?: string | null;
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
    if (filters.presetId && run.presetId !== filters.presetId) {
      return false;
    }
    if (filters.trigger && run.trigger !== filters.trigger) {
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
  const presetId = url.searchParams.get("preset_id");
  const trigger = url.searchParams.get("trigger");
  const suiteFingerprint = url.searchParams.get("suite_fingerprint");

  const filtered = filterRuns(allRuns, {
    status,
    preset,
    presetId,
    trigger,
    suiteFingerprint,
  });
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

export async function handleStartRun(
  request: Request,
  context: ServerContext,
): Promise<Response> {
  try {
    context.runController.assertRunnable();
    const spec = await context.runController.specFromRunRequest(request);
    const result = context.runController.start(spec);
    return jsonResponse(
      {
        run_id: result.runId,
        status: result.status,
      },
      { status: 202, requestId: context.requestId },
    );
  } catch (error) {
    if (error instanceof HttpInputError) {
      return errorResponse({
        status: error.status,
        type: error.code,
        message: error.message,
        requestId: context.requestId,
      });
    }
    if (error instanceof Error && error.name === "AgentProbeConfigError") {
      return errorResponse({
        status: 400,
        type: "bad_request",
        message: error.message,
        requestId: context.requestId,
      });
    }
    const message = error instanceof Error ? error.message : String(error);
    const isConflict = /unique constraint/i.test(message);
    return errorResponse({
      status: isConflict ? 409 : 500,
      type: isConflict ? "conflict" : "run_start_failed",
      message,
      requestId: context.requestId,
    });
  }
}

export function handleCancelRun(
  _request: Request,
  context: ServerContext,
  params: { runId: string },
): Response {
  try {
    const result = context.runController.cancel(params.runId);
    return jsonResponse(result, {
      status: 202,
      requestId: context.requestId,
    });
  } catch (error) {
    if (error instanceof HttpInputError) {
      return errorResponse({
        status: error.status,
        type: error.code,
        message: error.message,
        requestId: context.requestId,
      });
    }
    return errorResponse({
      status: 500,
      type: "cancel_failed",
      message: error instanceof Error ? error.message : String(error),
      requestId: context.requestId,
    });
  }
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

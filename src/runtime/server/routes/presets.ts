import type { ServerContext } from "../app-server.ts";
import { errorResponse, jsonResponse } from "../http-helpers.ts";
import { HttpInputError, readJsonObject } from "../validation.ts";

function routeError(error: unknown, requestId: string): Response {
  if (error instanceof HttpInputError) {
    return errorResponse({
      status: error.status,
      type: error.code,
      message: error.message,
      requestId,
    });
  }
  if (error instanceof Error && error.name === "AgentProbeConfigError") {
    return errorResponse({
      status: 400,
      type: "bad_request",
      message: error.message,
      requestId,
    });
  }
  return errorResponse({
    status: 500,
    type: "bad_request",
    message: error instanceof Error ? error.message : String(error),
    requestId,
  });
}

export function handleListPresets(
  _request: Request,
  context: ServerContext,
): Response {
  return jsonResponse(
    { presets: context.presetController.list() },
    { requestId: context.requestId },
  );
}

export function handleGetPreset(
  _request: Request,
  context: ServerContext,
  params: { presetId: string },
): Response {
  try {
    const result = context.presetController.get(params.presetId);
    if (!result) {
      return errorResponse({
        status: 404,
        type: "not_found",
        message: `Preset \`${params.presetId}\` was not found.`,
        requestId: context.requestId,
      });
    }
    return jsonResponse(result, { requestId: context.requestId });
  } catch (error) {
    return routeError(error, context.requestId);
  }
}

export async function handleCreatePreset(
  request: Request,
  context: ServerContext,
): Promise<Response> {
  try {
    const body = await readJsonObject(request);
    const preset = context.presetController.create(body);
    return jsonResponse(
      { preset },
      { status: 201, requestId: context.requestId },
    );
  } catch (error) {
    return routeError(error, context.requestId);
  }
}

export async function handleUpdatePreset(
  request: Request,
  context: ServerContext,
  params: { presetId: string },
): Promise<Response> {
  try {
    const body = await readJsonObject(request);
    const preset = context.presetController.update(params.presetId, body);
    if (!preset) {
      return errorResponse({
        status: 404,
        type: "not_found",
        message: `Preset \`${params.presetId}\` was not found.`,
        requestId: context.requestId,
      });
    }
    return jsonResponse({ preset }, { requestId: context.requestId });
  } catch (error) {
    return routeError(error, context.requestId);
  }
}

export function handleDeletePreset(
  _request: Request,
  context: ServerContext,
  params: { presetId: string },
): Response {
  const preset = context.presetController.delete(params.presetId);
  if (!preset) {
    return errorResponse({
      status: 404,
      type: "not_found",
      message: `Preset \`${params.presetId}\` was not found.`,
      requestId: context.requestId,
    });
  }
  return jsonResponse({ preset }, { requestId: context.requestId });
}

export function handlePresetRuns(
  _request: Request,
  context: ServerContext,
  params: { presetId: string },
): Response {
  const runs = context.presetController.runs(params.presetId);
  if (!runs) {
    return errorResponse({
      status: 404,
      type: "not_found",
      message: `Preset \`${params.presetId}\` was not found.`,
      requestId: context.requestId,
    });
  }
  return jsonResponse({ runs }, { requestId: context.requestId });
}

export async function handleStartPresetRun(
  request: Request,
  context: ServerContext,
  params: { presetId: string },
): Promise<Response> {
  try {
    context.runController.assertRunnable();
    const spec = await context.runController.specFromPresetRunRequest(
      params.presetId,
      request,
    );
    const result = context.runController.start(spec);
    return jsonResponse(
      { run_id: result.runId, status: result.status },
      { status: 202, requestId: context.requestId },
    );
  } catch (error) {
    return routeError(error, context.requestId);
  }
}

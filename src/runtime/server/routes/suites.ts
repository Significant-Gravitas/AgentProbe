import type { ServerContext } from "../app-server.ts";
import { errorResponse, jsonResponse } from "../http-helpers.ts";

export function handleListSuites(
  _request: Request,
  context: ServerContext,
): Response {
  const inventory = context.suiteController.inventory();
  return jsonResponse(
    {
      data_path: inventory.dataPath,
      scanned_at: inventory.scannedAt,
      suites: inventory.suites,
      errors: inventory.errors,
    },
    { requestId: context.requestId },
  );
}

export function handleListAllScenarios(
  _request: Request,
  context: ServerContext,
): Response {
  const inventory = context.suiteController.inventory();
  return jsonResponse(
    {
      scanned_at: inventory.scannedAt,
      scenarios: inventory.scenarios,
    },
    { requestId: context.requestId },
  );
}

export function handleListSuiteScenarios(
  _request: Request,
  context: ServerContext,
  params: { suiteId: string },
): Response {
  const suite = context.suiteController.suite(params.suiteId);
  if (!suite) {
    return errorResponse({
      status: 404,
      type: "NotFound",
      message: `Suite \`${params.suiteId}\` was not found.`,
      requestId: context.requestId,
    });
  }
  const scenarios = context.suiteController.scenariosForSuite(params.suiteId);
  return jsonResponse(
    {
      suite,
      scenarios,
    },
    { requestId: context.requestId },
  );
}

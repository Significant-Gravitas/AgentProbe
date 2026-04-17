import { renderRunReport } from "../../../domains/reporting/render-report.ts";
import type { ServerContext } from "../app-server.ts";
import { errorResponse } from "../http-helpers.ts";

export async function handleRunReport(
  _request: Request,
  context: ServerContext,
  params: { runId: string },
): Promise<Response> {
  if (!context.config.dbUrl) {
    return errorResponse({
      status: 404,
      type: "NotFound",
      message: `Run \`${params.runId}\` was not found (no database configured).`,
      requestId: context.requestId,
    });
  }

  const run = await context.repository.getRun(params.runId);
  if (!run) {
    return errorResponse({
      status: 404,
      type: "NotFound",
      message: `Run \`${params.runId}\` was not found.`,
      requestId: context.requestId,
    });
  }
  const html = renderRunReport(run);
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "x-request-id": context.requestId,
      "cache-control": "no-store",
    },
  });
}

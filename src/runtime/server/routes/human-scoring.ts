import type {
  HumanScoringQueueItem,
  HumanScoringRubricSummary,
} from "../../../providers/persistence/types.ts";
import type { ServerContext } from "../app-server.ts";
import { errorResponse, jsonResponse } from "../http-helpers.ts";
import { HttpInputError, readJsonObject } from "../validation.ts";

export async function handleListHumanScoringRubrics(
  _request: Request,
  context: ServerContext,
): Promise<Response> {
  if (!context.config.dbUrl) {
    return jsonResponse({ rubrics: [] }, { requestId: context.requestId });
  }
  try {
    const rubrics = await context.repository.listHumanScoringRubrics();
    return jsonResponse({ rubrics }, { requestId: context.requestId });
  } catch (error) {
    return errorResponse({
      status: 500,
      type: "PersistenceError",
      message: error instanceof Error ? error.message : String(error),
      requestId: context.requestId,
    });
  }
}

export async function handleGetNextHumanScoringItem(
  request: Request,
  context: ServerContext,
): Promise<Response> {
  if (!context.config.dbUrl) {
    return jsonResponse({ item: null }, { requestId: context.requestId });
  }
  const url = new URL(request.url);
  const rubricId = (url.searchParams.get("rubric_id") ?? "").trim();
  const dimensionId = (url.searchParams.get("dimension_id") ?? "").trim();
  if (!rubricId || !dimensionId) {
    return errorResponse({
      status: 400,
      type: "bad_request",
      message: "Both rubric_id and dimension_id are required.",
      requestId: context.requestId,
    });
  }
  try {
    const item = await context.repository.getNextUnscoredScenario(
      rubricId,
      dimensionId,
    );
    return jsonResponse({ item }, { requestId: context.requestId });
  } catch (error) {
    return errorResponse({
      status: 500,
      type: "PersistenceError",
      message: error instanceof Error ? error.message : String(error),
      requestId: context.requestId,
    });
  }
}

export async function handlePostHumanScore(
  request: Request,
  context: ServerContext,
): Promise<Response> {
  if (!context.config.dbUrl) {
    return errorResponse({
      status: 400,
      type: "bad_request",
      message: "No database is configured for human scoring.",
      requestId: context.requestId,
    });
  }

  let body: Record<string, unknown>;
  try {
    body = await readJsonObject(request);
  } catch (error) {
    if (error instanceof HttpInputError) {
      return errorResponse({
        status: error.status,
        type: error.code,
        message: error.message,
        requestId: context.requestId,
      });
    }
    throw error;
  }

  const scenarioRunId = body.scenario_run_id;
  const rubricId =
    typeof body.rubric_id === "string" ? body.rubric_id.trim() : "";
  const dimensionId =
    typeof body.dimension_id === "string" ? body.dimension_id.trim() : "";
  const rawScore = body.raw_score;

  if (
    typeof scenarioRunId !== "number" ||
    !Number.isInteger(scenarioRunId) ||
    scenarioRunId <= 0
  ) {
    return errorResponse({
      status: 400,
      type: "bad_request",
      message: "scenario_run_id must be a positive integer.",
      requestId: context.requestId,
    });
  }
  if (!rubricId || !dimensionId) {
    return errorResponse({
      status: 400,
      type: "bad_request",
      message: "rubric_id and dimension_id are required.",
      requestId: context.requestId,
    });
  }
  if (typeof rawScore !== "number" || !Number.isFinite(rawScore)) {
    return errorResponse({
      status: 400,
      type: "bad_request",
      message: "raw_score must be a finite number.",
      requestId: context.requestId,
    });
  }

  let rubrics: HumanScoringRubricSummary[];
  try {
    rubrics = await context.repository.listHumanScoringRubrics();
  } catch (error) {
    return errorResponse({
      status: 500,
      type: "PersistenceError",
      message: error instanceof Error ? error.message : String(error),
      requestId: context.requestId,
    });
  }
  const rubric = rubrics.find((r) => r.rubricId === rubricId);
  const dimension = rubric?.dimensions.find((d) => d.id === dimensionId);
  if (!rubric || !dimension) {
    return errorResponse({
      status: 404,
      type: "NotFound",
      message: `Unknown rubric \`${rubricId}\` or dimension \`${dimensionId}\`.`,
      requestId: context.requestId,
    });
  }

  const validRawScores = scaleAllowedScores(dimension.scale);
  if (!validRawScores.includes(rawScore)) {
    return errorResponse({
      status: 400,
      type: "bad_request",
      message: `raw_score ${rawScore} is not valid for dimension \`${dimensionId}\` (allowed: ${validRawScores.join(", ")}).`,
      requestId: context.requestId,
    });
  }

  try {
    await context.repository.recordHumanScore({
      scenarioRunId,
      dimensionId,
      dimensionName: dimension.name,
      scaleType: dimension.scale.type,
      scalePoints: dimension.scale.points ?? null,
      scoreDirection: dimension.scoreDirection ?? null,
      rawScore,
    });
  } catch (error) {
    return errorResponse({
      status: 500,
      type: "PersistenceError",
      message: error instanceof Error ? error.message : String(error),
      requestId: context.requestId,
    });
  }

  let next: HumanScoringQueueItem | null;
  try {
    next = await context.repository.getNextUnscoredScenario(
      rubricId,
      dimensionId,
    );
  } catch (error) {
    return errorResponse({
      status: 500,
      type: "PersistenceError",
      message: error instanceof Error ? error.message : String(error),
      requestId: context.requestId,
    });
  }

  return jsonResponse(
    { ok: true, next },
    { status: 200, requestId: context.requestId },
  );
}

function scaleAllowedScores(scale: {
  type: string;
  points?: number;
  labels: Record<string, string>;
}): number[] {
  if (scale.type === "binary") {
    return [0, 1];
  }
  if (typeof scale.points === "number" && scale.points > 0) {
    return Array.from(
      { length: Math.floor(scale.points) },
      (_, index) => index + 1,
    );
  }
  const fromLabels = Object.keys(scale.labels ?? {})
    .map((key) => Number(key))
    .filter((value) => Number.isFinite(value));
  if (fromLabels.length > 0) {
    return fromLabels.sort((a, b) => a - b);
  }
  return [1, 2, 3, 4, 5];
}

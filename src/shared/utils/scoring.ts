import type {
  RubricDimension,
  RubricScale,
  ScaleType,
  ScoreDirection,
} from "../types/contracts.ts";

function scalePoints(scalePoints?: number | null): number {
  return typeof scalePoints === "number" && scalePoints > 0 ? scalePoints : 1;
}

export function normalizeRawScore(options: {
  rawScore: number;
  scaleType?: ScaleType | string;
  scalePoints?: number | null;
  scoreDirection?: ScoreDirection | null;
}): number {
  if (options.scaleType === "binary") {
    const normalized = options.rawScore >= 1 ? 1 : 0;
    return options.scoreDirection === "lower_is_better"
      ? 1 - normalized
      : normalized;
  }

  const points = scalePoints(options.scalePoints);
  if (options.scoreDirection === "lower_is_better") {
    return (points + 1 - options.rawScore) / points;
  }
  return options.rawScore / points;
}

export function normalizeDimensionScore(
  dimension: Pick<RubricDimension, "scale" | "scoreDirection"> | undefined,
  rawScore: number,
): number {
  return normalizeRawScore({
    rawScore,
    scaleType: dimension?.scale.type,
    scalePoints: dimension?.scale.points,
    scoreDirection: dimension?.scoreDirection,
  });
}

function scoreValuesFromLabels(scale: RubricScale): number[] {
  return Object.keys(scale.labels ?? {})
    .map((key) => Number(key))
    .filter((value) => Number.isFinite(value));
}

export function bestRawScoreForDimension(
  dimension: Pick<RubricDimension, "scale" | "scoreDirection">,
): number {
  if (dimension.scale.type === "binary") {
    return dimension.scoreDirection === "lower_is_better" ? 0 : 1;
  }

  const labelValues = scoreValuesFromLabels(dimension.scale);
  if (labelValues.length > 0) {
    return dimension.scoreDirection === "lower_is_better"
      ? Math.min(...labelValues)
      : Math.max(...labelValues);
  }

  const points = scalePoints(dimension.scale.points);
  return dimension.scoreDirection === "lower_is_better" ? 1 : points;
}

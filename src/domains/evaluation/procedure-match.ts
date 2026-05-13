/**
 * Procedure-structure matching primitives for the procedure-extraction scorer.
 *
 * Given a `golden` procedure (ordered list of step IDs / labels, optional
 * parameter set) and a `predicted` procedure produced by the dream-pass
 * procedure-synthesis pipeline (`ProcedureMemory`), score how well they
 * match on three axes:
 *
 *   1. Step coverage      — Jaccard / F1 over the set of step labels
 *   2. Step order         — normalized Levenshtein edit distance over the
 *                            two step sequences (LCS-based normalization)
 *   3. Parameter coverage — Jaccard over named parameters
 *
 * No I/O. All math is pure and pinned by known-answer tests.
 */

import { precisionAtK, recallAtK } from "./ranking.ts";

/** Normalize a step or parameter label for matching. */
function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map(normalize))];
}

export type StepCoverage = {
  precision: number;
  recall: number;
  f1: number;
  matchedSteps: string[];
  missingSteps: string[];
  extraSteps: string[];
};

/**
 * Set-level coverage of predicted steps vs golden steps. Uses normalized
 * exact equality (case-insensitive, whitespace-trimmed) — substring matching
 * would be too lax for procedure step labels.
 */
export function stepCoverage(
  predicted: readonly string[],
  golden: readonly string[],
): StepCoverage {
  const predicted_ = unique(predicted);
  const golden_ = unique(golden);
  const goldenSet = new Set(golden_);
  const predictedSet = new Set(predicted_);

  const matched = predicted_.filter((step) => goldenSet.has(step));
  const missing = golden_.filter((step) => !predictedSet.has(step));
  const extra = predicted_.filter((step) => !goldenSet.has(step));

  const precision =
    predicted_.length === 0
      ? golden_.length === 0
        ? 1
        : 0
      : matched.length / predicted_.length;
  const recall = golden_.length === 0 ? 1 : matched.length / golden_.length;
  const f1 =
    precision + recall === 0
      ? 0
      : (2 * precision * recall) / (precision + recall);
  return {
    precision,
    recall,
    f1,
    matchedSteps: matched,
    missingSteps: missing,
    extraSteps: extra,
  };
}

/**
 * Length of the longest common subsequence between `a` and `b`. O(|a| * |b|)
 * time and space — fine for procedures of <100 steps; we don't need the
 * Hirschberg refinement.
 */
export function longestCommonSubsequenceLength(
  a: readonly string[],
  b: readonly string[],
): number {
  const an = a.map(normalize);
  const bn = b.map(normalize);
  const rows = an.length + 1;
  const cols = bn.length + 1;
  const dp = new Array<number>(rows * cols).fill(0);
  const at = (i: number, j: number): number => dp[i * cols + j] ?? 0;
  const set = (i: number, j: number, value: number): void => {
    dp[i * cols + j] = value;
  };
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      if (an[i - 1] === bn[j - 1]) {
        set(i, j, at(i - 1, j - 1) + 1);
      } else {
        set(i, j, Math.max(at(i - 1, j), at(i, j - 1)));
      }
    }
  }
  return at(an.length, bn.length);
}

/**
 * Order similarity in [0, 1]. Computed as `LCS / max(|a|, |b|)`. Two
 * identical sequences yield 1; two with no shared elements yield 0.
 *
 * This is intentionally different from raw Levenshtein. Procedures are
 * order-sensitive but tolerate insertions/deletions; LCS-normalized
 * similarity matches what the dream-pass extractor is trying to recover.
 */
export function orderSimilarity(
  predicted: readonly string[],
  golden: readonly string[],
): number {
  if (predicted.length === 0 && golden.length === 0) {
    return 1;
  }
  const denom = Math.max(predicted.length, golden.length);
  if (denom === 0) {
    return 1;
  }
  const lcs = longestCommonSubsequenceLength(predicted, golden);
  return lcs / denom;
}

export type ParameterCoverage = {
  jaccard: number;
  matched: string[];
  missing: string[];
  extra: string[];
};

export function parameterCoverage(
  predicted: readonly string[],
  golden: readonly string[],
): ParameterCoverage {
  const predicted_ = unique(predicted);
  const golden_ = unique(golden);
  const goldenSet = new Set(golden_);
  const predictedSet = new Set(predicted_);
  const matched = predicted_.filter((p) => goldenSet.has(p));
  const missing = golden_.filter((p) => !predictedSet.has(p));
  const extra = predicted_.filter((p) => !goldenSet.has(p));
  const unionSize = new Set([...predicted_, ...golden_]).size;
  const jaccard = unionSize === 0 ? 1 : matched.length / unionSize;
  return { jaccard, matched, missing, extra };
}

export type ProcedureMatchInput = {
  predictedSteps: readonly string[];
  goldenSteps: readonly string[];
  predictedParameters?: readonly string[];
  goldenParameters?: readonly string[];
  weights?: {
    step_coverage?: number;
    step_order?: number;
    parameter_coverage?: number;
  };
  passThreshold?: number;
};

export type ProcedureMetricKey =
  | "step_coverage"
  | "step_order"
  | "parameter_coverage";

export type ProcedureMetricScore = {
  metric: ProcedureMetricKey;
  value: number;
  weight: number;
};

export type ProcedureScoreResult = {
  metrics: ProcedureMetricScore[];
  weightedScore: number;
  passThreshold: number;
  passed: boolean;
  step: StepCoverage;
  order: number;
  parameters: ParameterCoverage;
};

const DEFAULT_WEIGHTS = {
  step_coverage: 1,
  step_order: 1,
  parameter_coverage: 1,
};

const DEFAULT_PASS_THRESHOLD = 0.6;

/**
 * Score a single (predicted, golden) procedure pair. Use this when the
 * extractor produces one procedure per query.
 */
export function scoreProcedure(
  input: ProcedureMatchInput,
): ProcedureScoreResult {
  const step = stepCoverage(input.predictedSteps, input.goldenSteps);
  const order = orderSimilarity(input.predictedSteps, input.goldenSteps);
  const parameters = parameterCoverage(
    input.predictedParameters ?? [],
    input.goldenParameters ?? [],
  );
  const weights = { ...DEFAULT_WEIGHTS, ...(input.weights ?? {}) };

  const metrics: ProcedureMetricScore[] = [
    { metric: "step_coverage", value: step.f1, weight: weights.step_coverage },
    { metric: "step_order", value: order, weight: weights.step_order },
    {
      metric: "parameter_coverage",
      value: parameters.jaccard,
      weight: weights.parameter_coverage,
    },
  ];

  const totalWeight = metrics.reduce(
    (sum, item) => sum + Math.max(0, item.weight),
    0,
  );
  const weightedScore =
    totalWeight === 0
      ? 0
      : metrics.reduce(
          (sum, item) =>
            item.weight > 0 ? sum + item.value * item.weight : sum,
          0,
        ) / totalWeight;
  const passThreshold = input.passThreshold ?? DEFAULT_PASS_THRESHOLD;
  return {
    metrics,
    weightedScore,
    passThreshold,
    passed: weightedScore >= passThreshold,
    step,
    order,
    parameters,
  };
}

/**
 * Re-export the ranking primitives so callers that want to compose a
 * procedure score with retrieval-style metrics have one entry point.
 */
export { precisionAtK, recallAtK };

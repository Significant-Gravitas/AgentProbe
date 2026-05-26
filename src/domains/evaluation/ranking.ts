/**
 * Pure information-retrieval ranking metrics.
 *
 * All functions take a `relevance` vector — the binary relevance (0 or 1)
 * of the returned list at each rank position. They return values in [0, 1].
 *
 * No I/O, no LLM calls; this module is intended to be the load-bearing math
 * behind the YAML `retrieval:` scorer. Tests pin the algebra against
 * known-answer cases.
 */

/** Truncate to `k`, defaulting to the full length when `k` is undefined or invalid. */
function clampK(length: number, k: number | undefined): number {
  if (k === undefined || !Number.isFinite(k) || k <= 0) {
    return length;
  }
  return Math.min(length, Math.floor(k));
}

/**
 * Precision@k — fraction of the top-k returned items that are relevant.
 *
 * When `k` exceeds the returned list, the denominator stays at `k` so that
 * a short list still gets penalized for not surfacing enough items. This
 * matches the `pytrec_eval` convention.
 */
export function precisionAtK(relevance: number[], k: number): number {
  if (k <= 0) {
    return 0;
  }
  const limit = Math.min(relevance.length, Math.floor(k));
  let hits = 0;
  for (let index = 0; index < limit; index += 1) {
    if ((relevance[index] ?? 0) > 0) {
      hits += 1;
    }
  }
  return hits / Math.floor(k);
}

/**
 * Recall@k — fraction of all relevant items that appear in the top-k.
 *
 * `totalRelevant` is the total number of items the suite expected to be
 * relevant (the size of the golden set), not the count of relevant items
 * actually returned. When `totalRelevant` is 0, recall is defined as 1
 * (no expectations means nothing to miss).
 */
export function recallAtK(
  relevance: number[],
  k: number,
  totalRelevant: number,
): number {
  if (totalRelevant <= 0) {
    return 1;
  }
  if (k <= 0) {
    return 0;
  }
  const limit = clampK(relevance.length, k);
  let hits = 0;
  for (let index = 0; index < limit; index += 1) {
    if ((relevance[index] ?? 0) > 0) {
      hits += 1;
    }
  }
  return hits / totalRelevant;
}

/**
 * Mean reciprocal rank — `1 / rankOfFirstHit`, or 0 when no relevant item is
 * returned. Computed for a single query (the "mean" is implicit when the
 * caller averages across multiple queries).
 *
 * When `k` is provided, only the first `k` positions are considered, so a
 * hit at rank `k + 1` is treated as no hit.
 */
export function mrr(relevance: number[], k?: number): number {
  const limit = clampK(relevance.length, k);
  for (let index = 0; index < limit; index += 1) {
    if ((relevance[index] ?? 0) > 0) {
      return 1 / (index + 1);
    }
  }
  return 0;
}

function dcgAtK(relevance: number[], k: number): number {
  const limit = clampK(relevance.length, k);
  let dcg = 0;
  for (let index = 0; index < limit; index += 1) {
    const rel = relevance[index] ?? 0;
    if (rel <= 0) {
      continue;
    }
    // log2(rank + 1) discount, with rank starting at 1.
    dcg += rel / Math.log2(index + 2);
  }
  return dcg;
}

/**
 * Normalized discounted cumulative gain at k.
 *
 * Uses the classic `log2(rank + 1)` discount and idealizes DCG against the
 * relevance vector sorted descending. With binary relevance this collapses to
 * the standard NDCG@k.
 *
 * When the ideal DCG is 0 (no relevant items expected), NDCG is defined as 0.
 */
export function ndcgAtK(relevance: number[], k: number): number {
  if (k <= 0) {
    return 0;
  }
  const idealRelevance = [...relevance].sort((left, right) => right - left);
  const ideal = dcgAtK(idealRelevance, k);
  if (ideal <= 0) {
    return 0;
  }
  return dcgAtK(relevance, k) / ideal;
}

export type RankingMetricKey =
  | "precision_at_k"
  | "recall_at_k"
  | "mrr"
  | "ndcg_at_k";

export type RankingMetricResult = {
  metric: RankingMetricKey;
  value: number;
  weight: number;
};

export type RankingScoreResult = {
  k: number;
  totalRelevant: number;
  totalReturned: number;
  hitCount: number;
  forbiddenHits: number;
  metrics: RankingMetricResult[];
  /** Weighted average across the metrics that carry positive weight. */
  weightedScore: number;
  /** True when score >= `passThreshold` AND no forbidden items appeared in top-k. */
  passed: boolean;
};

export type RankingWeights = Partial<Record<RankingMetricKey, number>>;

export type RankingScoreInput = {
  /** The list of returned items, in rank order. */
  returned: string[];
  /** The golden set of relevant items. */
  golden: string[];
  /**
   * Optional forbidden items. Any forbidden item that appears in the top-k
   * forces `passed: false` and is reported via `forbiddenHits`.
   */
  forbidden?: string[];
  /** Rank cutoff. Defaults to `Math.max(returned.length, golden.length)`. */
  k?: number;
  /** Per-metric weights. Metrics with weight 0 (or absent) are still reported but excluded from `weightedScore`. */
  weights?: RankingWeights;
  /** Match policy applied to each `returned` vs `golden` comparison. */
  match?: MatchPolicy;
  /** Pass threshold on the `weightedScore`. Defaults to 0.5. */
  passThreshold?: number;
};

export type MatchPolicy = "exact" | "substring" | "regex";

const DEFAULT_WEIGHTS: Required<RankingWeights> = {
  precision_at_k: 1,
  recall_at_k: 1,
  mrr: 1,
  ndcg_at_k: 1,
};

const DEFAULT_PASS_THRESHOLD = 0.5;

function normalizeString(value: string): string {
  return value.trim().toLowerCase();
}

function matchesItem(
  returned: string,
  expected: string,
  policy: MatchPolicy,
): boolean {
  switch (policy) {
    case "exact":
      return normalizeString(returned) === normalizeString(expected);
    case "substring": {
      const candidate = normalizeString(returned);
      const needle = normalizeString(expected);
      if (!needle) {
        return false;
      }
      return candidate.includes(needle) || needle.includes(candidate);
    }
    case "regex":
      try {
        return new RegExp(expected, "i").test(returned);
      } catch {
        return false;
      }
  }
}

/**
 * Build the binary-relevance vector for `returned` against `golden`.
 *
 * Each returned item counts as a hit when any golden item matches under the
 * supplied policy. Golden items can be matched by multiple returned items
 * (i.e. duplicates in `returned` do not double-count gold coverage, but each
 * occurrence is still marked relevant in the vector — this matches the
 * standard IR convention because rank-based metrics naturally penalize
 * duplicates via the discount and the `totalRelevant` denominator).
 */
export function buildRelevanceVector(
  returned: string[],
  golden: string[],
  policy: MatchPolicy = "substring",
): number[] {
  return returned.map((candidate) =>
    golden.some((expected) => matchesItem(candidate, expected, policy)) ? 1 : 0,
  );
}

/**
 * Count distinct gold items that the returned list covers in the top-k.
 *
 * This is the numerator used by `recallAtK` when we want recall to reflect
 * *unique* gold coverage rather than total relevant returns. It tolerates
 * duplicates in `returned` without double-counting.
 */
export function countUniqueGoldHits(
  returned: string[],
  golden: string[],
  k: number,
  policy: MatchPolicy = "substring",
): number {
  if (k <= 0) {
    return 0;
  }
  const limit = clampK(returned.length, k);
  const matched = new Set<number>();
  for (let index = 0; index < limit; index += 1) {
    const candidate = returned[index] ?? "";
    for (let gIndex = 0; gIndex < golden.length; gIndex += 1) {
      if (matched.has(gIndex)) {
        continue;
      }
      if (matchesItem(candidate, golden[gIndex] ?? "", policy)) {
        matched.add(gIndex);
      }
    }
  }
  return matched.size;
}

function countForbiddenHits(
  returned: string[],
  forbidden: string[],
  k: number,
  policy: MatchPolicy,
): number {
  if (forbidden.length === 0 || k <= 0) {
    return 0;
  }
  const limit = clampK(returned.length, k);
  let hits = 0;
  for (let index = 0; index < limit; index += 1) {
    const candidate = returned[index] ?? "";
    if (
      forbidden.some((forbiddenItem) =>
        matchesItem(candidate, forbiddenItem, policy),
      )
    ) {
      hits += 1;
    }
  }
  return hits;
}

/**
 * Top-level ranking scorer. Computes the four canonical metrics and
 * aggregates them under a weighted average. Forbidden items override the
 * pass decision regardless of metric values.
 */
export function scoreRanking(input: RankingScoreInput): RankingScoreResult {
  const policy = input.match ?? "substring";
  const k = clampK(
    Math.max(input.returned.length, input.golden.length, 1),
    input.k,
  );
  const relevance = buildRelevanceVector(input.returned, input.golden, policy);
  const uniqueHits = countUniqueGoldHits(
    input.returned,
    input.golden,
    k,
    policy,
  );

  const weights: Required<RankingWeights> = {
    ...DEFAULT_WEIGHTS,
    ...(input.weights ?? {}),
  };

  // Recall uses unique gold coverage to keep the math meaningful when the
  // returned list contains duplicates.
  const recallVectorHits = uniqueHits;
  const recall =
    input.golden.length === 0 ? 1 : recallVectorHits / input.golden.length;

  const metrics: RankingMetricResult[] = [
    {
      metric: "precision_at_k",
      value: precisionAtK(relevance, k),
      weight: weights.precision_at_k,
    },
    {
      metric: "recall_at_k",
      value: recall,
      weight: weights.recall_at_k,
    },
    {
      metric: "mrr",
      value: mrr(relevance, k),
      weight: weights.mrr,
    },
    {
      metric: "ndcg_at_k",
      value: ndcgAtK(relevance, k),
      weight: weights.ndcg_at_k,
    },
  ];

  const totalWeight = metrics.reduce(
    (sum, item) => sum + (item.weight > 0 ? item.weight : 0),
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

  const forbidden = input.forbidden ?? [];
  const forbiddenHits = countForbiddenHits(
    input.returned,
    forbidden,
    k,
    policy,
  );
  const passThreshold = input.passThreshold ?? DEFAULT_PASS_THRESHOLD;
  const passed = forbiddenHits === 0 && weightedScore >= passThreshold;

  const hitCount = relevance.reduce(
    (sum, value) => sum + (value > 0 ? 1 : 0),
    0,
  );

  return {
    k,
    totalRelevant: input.golden.length,
    totalReturned: input.returned.length,
    hitCount,
    forbiddenHits,
    metrics,
    weightedScore,
    passed,
  };
}

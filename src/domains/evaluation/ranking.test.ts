import { describe, expect, test } from "bun:test";

import {
  buildRelevanceVector,
  countUniqueGoldHits,
  mrr,
  ndcgAtK,
  precisionAtK,
  recallAtK,
  scoreRanking,
} from "./ranking.ts";

describe("precisionAtK", () => {
  test("counts hits in the top-k window", () => {
    expect(precisionAtK([1, 1, 0], 2)).toBeCloseTo(1.0, 6);
    expect(precisionAtK([1, 0, 1], 3)).toBeCloseTo(2 / 3, 6);
    expect(precisionAtK([0, 0, 0], 3)).toBe(0);
  });

  test("uses k as the denominator even when fewer items were returned", () => {
    // Two items returned, both relevant, but k=5 — short list still penalized.
    expect(precisionAtK([1, 1], 5)).toBeCloseTo(2 / 5, 6);
  });

  test("returns 0 for non-positive k", () => {
    expect(precisionAtK([1, 1, 1], 0)).toBe(0);
  });
});

describe("recallAtK", () => {
  test("returns 1 when there are no expected items", () => {
    expect(recallAtK([0, 0, 0], 5, 0)).toBe(1);
  });

  test("scales by total relevant", () => {
    expect(recallAtK([1, 0, 1], 3, 2)).toBeCloseTo(1.0, 6);
    expect(recallAtK([1, 0, 1], 3, 4)).toBeCloseTo(0.5, 6);
    expect(recallAtK([1, 0, 0], 3, 2)).toBeCloseTo(0.5, 6);
  });

  test("only counts hits within the cutoff", () => {
    expect(recallAtK([0, 0, 1], 2, 1)).toBe(0);
    expect(recallAtK([0, 0, 1], 3, 1)).toBe(1);
  });
});

describe("mrr", () => {
  test("returns the reciprocal of the first hit rank", () => {
    expect(mrr([0, 0, 1])).toBeCloseTo(1 / 3, 6);
    expect(mrr([1, 0, 0])).toBeCloseTo(1.0, 6);
    expect(mrr([0, 1, 1])).toBeCloseTo(0.5, 6);
  });

  test("returns 0 when no hits", () => {
    expect(mrr([0, 0, 0])).toBe(0);
  });

  test("respects the k cutoff", () => {
    // Hit at rank 3 but k=2 — treat as no hit.
    expect(mrr([0, 0, 1], 2)).toBe(0);
    expect(mrr([0, 0, 1], 3)).toBeCloseTo(1 / 3, 6);
  });
});

describe("ndcgAtK", () => {
  test("perfect ranking yields 1", () => {
    expect(ndcgAtK([1, 1, 1], 3)).toBeCloseTo(1.0, 6);
    expect(ndcgAtK([1, 1, 0], 3)).toBeCloseTo(1.0, 6);
  });

  test("NDCG of [1, 0, 1] with log2 discount", () => {
    // DCG = 1/log2(2) + 0/log2(3) + 1/log2(4) = 1 + 0 + 0.5 = 1.5
    // ideal DCG (sorted desc = [1, 1, 0]) = 1/log2(2) + 1/log2(3) + 0 = 1 + ~0.6309 = ~1.6309
    // NDCG = 1.5 / 1.6309 = ~0.9197
    expect(ndcgAtK([1, 0, 1], 3)).toBeCloseTo(0.91972, 4);
  });

  test("returns 0 when no relevant items exist", () => {
    expect(ndcgAtK([0, 0, 0], 3)).toBe(0);
  });

  test("respects the k cutoff", () => {
    // Relevant only at rank 3, k=2 — DCG over window is 0.
    expect(ndcgAtK([0, 0, 1], 2)).toBe(0);
    // Same vector, k=3, DCG = 1/log2(4) = 0.5, ideal = 1, => 0.5.
    expect(ndcgAtK([0, 0, 1], 3)).toBeCloseTo(0.5, 6);
  });
});

describe("buildRelevanceVector", () => {
  test("substring policy is case-insensitive and bidirectional", () => {
    const returned = ["Sarah's email address", "Random other note"];
    const golden = ["sarah"];
    expect(buildRelevanceVector(returned, golden, "substring")).toEqual([1, 0]);
  });

  test("exact policy requires full normalized equality", () => {
    expect(
      buildRelevanceVector(["Atlas Project Status"], ["atlas project status"], "exact"),
    ).toEqual([1]);
    expect(
      buildRelevanceVector(["Atlas Project"], ["Atlas Project Status"], "exact"),
    ).toEqual([0]);
  });

  test("regex policy interprets the golden item as a pattern", () => {
    expect(
      buildRelevanceVector(["budget: $50K"], ["\\$50k"], "regex"),
    ).toEqual([1]);
  });

  test("returns 0 for empty golden item to avoid false matches", () => {
    expect(buildRelevanceVector(["anything"], [""], "substring")).toEqual([0]);
  });
});

describe("countUniqueGoldHits", () => {
  test("dedupes duplicate returns against the same gold item", () => {
    const returned = ["Sarah", "Sarah", "Atlas"];
    const golden = ["Sarah", "Atlas"];
    expect(countUniqueGoldHits(returned, golden, 5)).toBe(2);
  });

  test("respects k cutoff", () => {
    const returned = ["Atlas", "Sarah"];
    const golden = ["Sarah", "Atlas"];
    expect(countUniqueGoldHits(returned, golden, 1)).toBe(1);
    expect(countUniqueGoldHits(returned, golden, 2)).toBe(2);
  });
});

describe("scoreRanking", () => {
  test("perfect top-k returns weightedScore 1 and passes", () => {
    const result = scoreRanking({
      returned: ["sarahs email", "atlas project status"],
      golden: ["sarah", "atlas project"],
      k: 2,
    });

    expect(result.k).toBe(2);
    expect(result.hitCount).toBe(2);
    expect(result.forbiddenHits).toBe(0);
    expect(result.weightedScore).toBeCloseTo(1.0, 6);
    expect(result.passed).toBe(true);
  });

  test("missing gold items lower recall and weighted score", () => {
    const result = scoreRanking({
      returned: ["unrelated note"],
      golden: ["sarah", "atlas project"],
      k: 5,
      passThreshold: 0.5,
    });

    expect(result.hitCount).toBe(0);
    expect(result.weightedScore).toBe(0);
    expect(result.passed).toBe(false);
  });

  test("forbidden hits force a fail even when score is high", () => {
    const result = scoreRanking({
      returned: ["sarah", "old budget figure"],
      golden: ["sarah"],
      forbidden: ["old budget"],
      k: 2,
      passThreshold: 0.3,
    });

    expect(result.forbiddenHits).toBe(1);
    expect(result.passed).toBe(false);
  });

  test("weight=0 excludes a metric from weightedScore without dropping the report", () => {
    const result = scoreRanking({
      returned: ["sarah"],
      golden: ["sarah", "atlas"],
      weights: {
        precision_at_k: 1,
        recall_at_k: 0,
        mrr: 1,
        ndcg_at_k: 1,
      },
      k: 1,
    });

    const recall = result.metrics.find((item) => item.metric === "recall_at_k");
    expect(recall?.weight).toBe(0);
    // recall at k=1 with 2 gold items is 0.5; weightedScore should ignore it.
    // precision=1, mrr=1, ndcg=1 -> average 1.0
    expect(result.weightedScore).toBeCloseTo(1.0, 6);
  });

  test("defaults k to max(|returned|, |golden|, 1)", () => {
    const result = scoreRanking({
      returned: ["a", "b", "c"],
      golden: ["a"],
    });
    expect(result.k).toBe(3);
  });

  test("zero golden items yields trivial recall=1 and a score driven by precision-style metrics", () => {
    const result = scoreRanking({
      returned: [],
      golden: [],
    });
    const recall = result.metrics.find((item) => item.metric === "recall_at_k");
    expect(recall?.value).toBe(1);
  });
});

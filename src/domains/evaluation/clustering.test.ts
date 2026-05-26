import { describe, expect, test } from "bun:test";

import {
  adjustedRandIndex,
  pairwiseAgreement,
  pairwiseScores,
  scoreClustering,
} from "./clustering.ts";

describe("pairwiseAgreement", () => {
  test("perfect agreement counts every same-cluster pair as TP", () => {
    const result = pairwiseAgreement([["a", "b", "c"]], [["a", "b", "c"]]);
    expect(result.truePositives).toBe(3);
    expect(result.falsePositives).toBe(0);
    expect(result.falseNegatives).toBe(0);
    expect(result.trueNegatives).toBe(0);
  });

  test("over-merging counts as false positives", () => {
    // Predicted merges {a, b}; golden keeps them separate.
    const result = pairwiseAgreement([["a", "b"]], [["a"], ["b"]]);
    expect(result.truePositives).toBe(0);
    expect(result.falsePositives).toBe(1);
    expect(result.falseNegatives).toBe(0);
    expect(result.trueNegatives).toBe(0);
  });

  test("under-merging counts as false negatives", () => {
    // Predicted keeps them separate; golden merges them.
    const result = pairwiseAgreement([["a"], ["b"]], [["a", "b"]]);
    expect(result.truePositives).toBe(0);
    expect(result.falsePositives).toBe(0);
    expect(result.falseNegatives).toBe(1);
    expect(result.trueNegatives).toBe(0);
  });
});

describe("pairwiseScores", () => {
  test("perfect partition yields F1 of 1.0", () => {
    const result = pairwiseScores(
      [
        ["a", "b"],
        ["c", "d"],
      ],
      [
        ["a", "b"],
        ["c", "d"],
      ],
    );
    expect(result.precision).toBeCloseTo(1.0, 6);
    expect(result.recall).toBeCloseTo(1.0, 6);
    expect(result.f1).toBeCloseTo(1.0, 6);
  });

  test("over-merging drops precision more than recall", () => {
    // Golden: {a, b}, {c, d}. Predicted: {a, b, c, d} (over-merge).
    // Pairs: (a,b), (a,c), (a,d), (b,c), (b,d), (c,d) = 6 same-cluster predicted
    // Of those, (a,b) and (c,d) are also same in golden -> TP=2, FP=4, FN=0
    const result = pairwiseScores(
      [["a", "b", "c", "d"]],
      [
        ["a", "b"],
        ["c", "d"],
      ],
    );
    expect(result.precision).toBeCloseTo(2 / 6, 6);
    expect(result.recall).toBeCloseTo(1.0, 6);
  });

  test("under-merging drops recall more than precision", () => {
    // Golden: {a, b, c, d}. Predicted: {a, b}, {c, d}.
    const result = pairwiseScores(
      [
        ["a", "b"],
        ["c", "d"],
      ],
      [["a", "b", "c", "d"]],
    );
    expect(result.precision).toBeCloseTo(1.0, 6);
    expect(result.recall).toBeCloseTo(2 / 6, 6);
  });
});

describe("adjustedRandIndex", () => {
  test("perfect agreement yields ARI = 1", () => {
    expect(
      adjustedRandIndex(
        [
          ["a", "b"],
          ["c", "d"],
        ],
        [
          ["a", "b"],
          ["c", "d"],
        ],
      ),
    ).toBeCloseTo(1.0, 6);
  });

  test("complete disagreement on two pairs", () => {
    // Golden: {a, b}, {c, d}. Predicted: {a, c}, {b, d}.
    // Hubert-Arabie: index = 0 (no shared same-cluster pairs),
    //   sumPredChoose = C(2,2)+C(2,2) = 2, sumGoldChoose = 2,
    //   expected = 2*2/C(4,2) = 2/3, maxIndex = 2,
    //   ARI = (0 - 2/3) / (2 - 2/3) = -0.5.
    expect(
      adjustedRandIndex(
        [
          ["a", "c"],
          ["b", "d"],
        ],
        [
          ["a", "b"],
          ["c", "d"],
        ],
      ),
    ).toBeCloseTo(-0.5, 6);
  });

  test("ARI is symmetric in its inputs", () => {
    const left = [
      ["a", "b", "c"],
      ["d", "e"],
    ];
    const right = [
      ["a", "b"],
      ["c", "d", "e"],
    ];
    expect(adjustedRandIndex(left, right)).toBeCloseTo(
      adjustedRandIndex(right, left),
      6,
    );
  });

  test("single-item input yields ARI = 1", () => {
    expect(adjustedRandIndex([["a"]], [["a"]])).toBe(1);
  });
});

describe("scoreClustering", () => {
  test("aggregates precision/recall/F1/ARI in one call", () => {
    const result = scoreClustering(
      [
        ["a", "b"],
        ["c", "d"],
      ],
      [
        ["a", "b"],
        ["c", "d"],
      ],
    );
    expect(result.precision).toBeCloseTo(1.0, 6);
    expect(result.recall).toBeCloseTo(1.0, 6);
    expect(result.f1).toBeCloseTo(1.0, 6);
    expect(result.ari).toBeCloseTo(1.0, 6);
    expect(result.itemCount).toBe(4);
  });
});

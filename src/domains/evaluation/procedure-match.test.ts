import { describe, expect, test } from "bun:test";

import {
  longestCommonSubsequenceLength,
  orderSimilarity,
  parameterCoverage,
  scoreProcedure,
  stepCoverage,
} from "./procedure-match.ts";

describe("stepCoverage", () => {
  test("perfect coverage yields F1 of 1.0", () => {
    const result = stepCoverage(["a", "b", "c"], ["a", "b", "c"]);
    expect(result.f1).toBeCloseTo(1.0, 6);
    expect(result.matchedSteps).toEqual(["a", "b", "c"]);
    expect(result.missingSteps).toEqual([]);
    expect(result.extraSteps).toEqual([]);
  });

  test("missing one step drops recall", () => {
    const result = stepCoverage(["a", "b"], ["a", "b", "c"]);
    expect(result.precision).toBeCloseTo(1.0, 6);
    expect(result.recall).toBeCloseTo(2 / 3, 6);
    expect(result.missingSteps).toEqual(["c"]);
  });

  test("extra step drops precision", () => {
    const result = stepCoverage(["a", "b", "junk"], ["a", "b"]);
    expect(result.precision).toBeCloseTo(2 / 3, 6);
    expect(result.recall).toBeCloseTo(1.0, 6);
    expect(result.extraSteps).toEqual(["junk"]);
  });

  test("normalization is case-insensitive and whitespace-trimmed", () => {
    const result = stepCoverage(
      [" Open Ticket ", "ASSIGN"],
      ["open ticket", "assign"],
    );
    expect(result.f1).toBeCloseTo(1.0, 6);
  });
});

describe("longestCommonSubsequenceLength", () => {
  test("identical sequences yield length |seq|", () => {
    expect(longestCommonSubsequenceLength(["a", "b", "c"], ["a", "b", "c"])).toBe(3);
  });

  test("disjoint sequences yield 0", () => {
    expect(longestCommonSubsequenceLength(["a", "b"], ["c", "d"])).toBe(0);
  });

  test("classic ABCBDAB / BDCAB example yields 4", () => {
    // LCS of "abcbdab" and "bdcab" is "bcab" (length 4) — a canonical CLRS case.
    expect(
      longestCommonSubsequenceLength(
        ["a", "b", "c", "b", "d", "a", "b"],
        ["b", "d", "c", "a", "b"],
      ),
    ).toBe(4);
  });
});

describe("orderSimilarity", () => {
  test("identical order is 1.0", () => {
    expect(orderSimilarity(["a", "b", "c"], ["a", "b", "c"])).toBeCloseTo(1.0, 6);
  });

  test("reversed order with shared elements drops below 1.0", () => {
    // LCS of [a,b,c] and [c,b,a] is 1 (b alone, or a/c alone); max length 3 => 1/3.
    expect(orderSimilarity(["a", "b", "c"], ["c", "b", "a"])).toBeCloseTo(1 / 3, 6);
  });

  test("empty inputs degrade to 1", () => {
    expect(orderSimilarity([], [])).toBe(1);
  });
});

describe("parameterCoverage", () => {
  test("identical sets yield Jaccard 1.0", () => {
    const result = parameterCoverage(
      ["ticket_id", "assignee"],
      ["ticket_id", "assignee"],
    );
    expect(result.jaccard).toBeCloseTo(1.0, 6);
    expect(result.missing).toEqual([]);
    expect(result.extra).toEqual([]);
  });

  test("missing one and extra one penalize symmetrically", () => {
    const result = parameterCoverage(["ticket_id", "junk"], ["ticket_id", "assignee"]);
    // matched=1, union={ticket_id, junk, assignee}=3 -> 1/3
    expect(result.jaccard).toBeCloseTo(1 / 3, 6);
  });
});

describe("scoreProcedure", () => {
  test("perfect match passes with weightedScore 1.0", () => {
    const result = scoreProcedure({
      predictedSteps: ["open ticket", "assign", "close"],
      goldenSteps: ["open ticket", "assign", "close"],
      predictedParameters: ["ticket_id"],
      goldenParameters: ["ticket_id"],
    });
    expect(result.weightedScore).toBeCloseTo(1.0, 6);
    expect(result.passed).toBe(true);
  });

  test("missing one of three steps still passes at default threshold", () => {
    const result = scoreProcedure({
      predictedSteps: ["open ticket", "assign"],
      goldenSteps: ["open ticket", "assign", "close"],
    });
    // step_coverage F1 = 2*(1.0 * 2/3)/(1.0 + 2/3) = 0.8
    // order similarity = LCS([open ticket, assign], [open ticket, assign, close]) / max(2,3) = 2/3
    // parameter_coverage (both empty) = 1
    // weighted avg = (0.8 + 2/3 + 1) / 3 = ~0.822
    expect(result.weightedScore).toBeGreaterThan(0.6);
    expect(result.passed).toBe(true);
  });

  test("reversed order drops weighted score below threshold", () => {
    const result = scoreProcedure({
      predictedSteps: ["close", "assign", "open ticket"],
      goldenSteps: ["open ticket", "assign", "close"],
    });
    // step_coverage F1 = 1.0; order similarity = 1/3; parameter = 1
    // weighted = (1.0 + 1/3 + 1) / 3 = ~0.778 — actually passes at 0.6
    expect(result.weightedScore).toBeGreaterThan(0);
    // But if step_order is weighted heavily it should fail:
    const heavy = scoreProcedure({
      predictedSteps: ["close", "assign", "open ticket"],
      goldenSteps: ["open ticket", "assign", "close"],
      weights: { step_coverage: 1, step_order: 5, parameter_coverage: 0 },
    });
    // (1.0 * 1 + 1/3 * 5 + 0) / 6 = ~0.444
    expect(heavy.weightedScore).toBeLessThan(0.6);
    expect(heavy.passed).toBe(false);
  });

  test("zero weights collapse cleanly", () => {
    const result = scoreProcedure({
      predictedSteps: ["a"],
      goldenSteps: ["a"],
      weights: { step_coverage: 0, step_order: 0, parameter_coverage: 0 },
    });
    expect(result.weightedScore).toBe(0);
    expect(result.passed).toBe(false);
  });
});

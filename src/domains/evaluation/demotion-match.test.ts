import { describe, expect, test } from "bun:test";

import {
  assertCascadeBounded,
  assertExpectedSet,
  assertTimestampDiscipline,
  scoreDemotion,
} from "./demotion-match.ts";

describe("assertExpectedSet", () => {
  test("perfect match yields F1 1.0", () => {
    const result = assertExpectedSet(["a", "b"], ["a", "b"]);
    expect(result.f1).toBeCloseTo(1.0, 6);
    expect(result.falsePositives).toEqual([]);
    expect(result.falseNegatives).toEqual([]);
  });

  test("touched the wrong edge yields FP and precision drop", () => {
    const result = assertExpectedSet(["a", "wrong"], ["a", "b"]);
    expect(result.falsePositives).toEqual(["wrong"]);
    expect(result.falseNegatives).toEqual(["b"]);
    expect(result.precision).toBeCloseTo(0.5, 6);
    expect(result.recall).toBeCloseTo(0.5, 6);
  });

  test("missed an expected edge yields FN and recall drop", () => {
    const result = assertExpectedSet(["a"], ["a", "b"]);
    expect(result.recall).toBeCloseTo(0.5, 6);
    expect(result.precision).toBeCloseTo(1.0, 6);
  });

  test("nothing expected and nothing touched is perfect", () => {
    const result = assertExpectedSet([], []);
    expect(result.f1).toBeCloseTo(1.0, 6);
  });
});

describe("assertTimestampDiscipline", () => {
  test("a clean retract (expired_at only) has no violation", () => {
    const violations = assertTimestampDiscipline(
      [
        {
          uuid: "edge1",
          expiredAtSet: true,
          invalidAtSet: false,
        },
      ],
      [],
    );
    expect(violations).toEqual([]);
  });

  test("a retract that also set invalid_at is flagged", () => {
    const violations = assertTimestampDiscipline(
      [
        {
          uuid: "edge1",
          expiredAtSet: true,
          invalidAtSet: true,
        },
      ],
      [],
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.expectation).toBe("retract_only_expired");
  });

  test("a soft_delete that set only one timestamp is flagged", () => {
    const violations = assertTimestampDiscipline(
      [],
      [
        {
          uuid: "edge2",
          expiredAtSet: true,
          invalidAtSet: false,
        },
      ],
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.expectation).toBe("soft_delete_both");
  });
});

describe("assertCascadeBounded", () => {
  test("touching only direct neighbors is bounded", () => {
    const result = assertCascadeBounded(["e_ab", "e_bc"], ["e_ab", "e_bc"], ["e_cd"]);
    expect(result.bounded).toBe(true);
    expect(result.touchedTangentialNeighbors).toEqual([]);
    expect(result.directNeighborF1).toBeCloseTo(1.0, 6);
  });

  test("touching a 2-hop edge is a runaway-demotion failure", () => {
    // Graph A -> B -> C -> D. Invalidate B. Direct: (A,B), (B,C). Tangential: (C,D).
    const result = assertCascadeBounded(
      ["e_ab", "e_bc", "e_cd"],
      ["e_ab", "e_bc"],
      ["e_cd"],
    );
    expect(result.bounded).toBe(false);
    expect(result.touchedTangentialNeighbors).toEqual(["e_cd"]);
  });

  test("missing a direct neighbor lowers directNeighborF1 but stays bounded", () => {
    const result = assertCascadeBounded(["e_ab"], ["e_ab", "e_bc"], ["e_cd"]);
    expect(result.bounded).toBe(true);
    expect(result.missedDirectNeighbors).toEqual(["e_bc"]);
    expect(result.directNeighborF1).toBeLessThan(1.0);
  });
});

describe("scoreDemotion", () => {
  test("perfect demotion of the expected set passes", () => {
    const result = scoreDemotion({
      observedDemotions: ["e1", "e2"],
      expectedDemotions: ["e1", "e2"],
      retractActions: [
        { uuid: "e1", expiredAtSet: true, invalidAtSet: false },
        { uuid: "e2", expiredAtSet: true, invalidAtSet: false },
      ],
    });
    expect(result.weightedScore).toBeCloseTo(1.0, 6);
    expect(result.passed).toBe(true);
  });

  test("a timestamp violation is a hard fail regardless of set match", () => {
    const result = scoreDemotion({
      observedDemotions: ["e1"],
      expectedDemotions: ["e1"],
      retractActions: [
        { uuid: "e1", expiredAtSet: true, invalidAtSet: true }, // wrong
      ],
    });
    expect(result.timestampViolations).toHaveLength(1);
    expect(result.passed).toBe(false);
  });

  test("a runaway cascade is a hard fail", () => {
    const result = scoreDemotion({
      observedDemotions: ["e_ab", "e_bc", "e_cd"],
      expectedDemotions: ["e_ab", "e_bc"],
      cascade: {
        touched: ["e_ab", "e_bc", "e_cd"],
        expectedDirectNeighbors: ["e_ab", "e_bc"],
        tangentialEdges: ["e_cd"],
      },
    });
    expect(result.cascade?.bounded).toBe(false);
    expect(result.passed).toBe(false);
  });
});

/**
 * Demotion-correctness primitives for the demotion-precision scorer.
 *
 * These score the *structural* half of demotion correctness — which edges
 * the dream pass actually touched vs which it was supposed to touch. They
 * cover:
 *
 *   - **P-1.3 retract-vs-soft-delete:** did `_retract_edges` set only
 *     `expired_at`, and did `_soft_delete_edges` set both? Scored by
 *     `assertTimestampDiscipline`.
 *   - **P0.3a stale-fact deprecation:** did the pass demote items that were
 *     genuinely stale and leave fresh items alone? Scored by
 *     `assertExpectedSet`.
 *   - **P0.3b scoped cascading expiry:** did the cascade touch the entity's
 *     direct neighbors and nothing 2+ hops away? Scored by
 *     `assertCascadeBounded`.
 *
 * The LLM-judged half (was the demotion semantically warranted?) goes
 * through the existing `judgeResponse` pipeline; this module is only the
 * deterministic structural check.
 *
 * All functions are pure.
 */

export type DemotionAction = {
  /** UUID of the edge or memory that was demoted. */
  uuid: string;
  /** Optional human label for reports. */
  label?: string;
  /** `expired_at` / `invalid_at` flags set by the operation. */
  expiredAtSet: boolean;
  invalidAtSet: boolean;
  /** New status property, if any. */
  status?: string;
};

export type SetCheckResult = {
  /** Items the dream pass correctly touched. */
  truePositives: string[];
  /** Items it touched but shouldn't have. */
  falsePositives: string[];
  /** Items it missed. */
  falseNegatives: string[];
  precision: number;
  recall: number;
  f1: number;
};

function normalize(value: string): string {
  return value.trim();
}

function dedup(values: readonly string[]): string[] {
  return [...new Set(values.map(normalize))];
}

/**
 * Set-level precision/recall over which UUIDs were touched vs the
 * `expected` set. The denominators degrade gracefully:
 *   - empty expected + empty observed = perfect score
 *   - empty expected + nonempty observed = precision 0, recall 1
 *   - nonempty expected + empty observed = precision 1, recall 0
 */
export function assertExpectedSet(
  observed: readonly string[],
  expected: readonly string[],
): SetCheckResult {
  const observed_ = dedup(observed);
  const expected_ = dedup(expected);
  const expectedSet = new Set(expected_);
  const observedSet = new Set(observed_);
  const tp = observed_.filter((id) => expectedSet.has(id));
  const fp = observed_.filter((id) => !expectedSet.has(id));
  const fn = expected_.filter((id) => !observedSet.has(id));
  const precision =
    observed_.length === 0
      ? expected_.length === 0
        ? 1
        : 0
      : tp.length / observed_.length;
  const recall = expected_.length === 0 ? 1 : tp.length / expected_.length;
  const f1 =
    precision + recall === 0
      ? 0
      : (2 * precision * recall) / (precision + recall);
  return {
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: fn,
    precision,
    recall,
    f1,
  };
}

export type TimestampViolation = {
  uuid: string;
  expectation: "retract_only_expired" | "soft_delete_both";
  observed: { expiredAtSet: boolean; invalidAtSet: boolean };
  message: string;
};

/**
 * Verify the Snodgrass bi-temporal discipline for a list of demotions.
 *
 * `retract` actions must set only `expired_at` (transaction-time
 * retraction). `soft_delete` actions must set BOTH `expired_at` and
 * `invalid_at` (the world changed AND we recorded it). Returns a list of
 * violations; empty list means the discipline held.
 */
export function assertTimestampDiscipline(
  retractActions: readonly DemotionAction[],
  softDeleteActions: readonly DemotionAction[],
): TimestampViolation[] {
  const violations: TimestampViolation[] = [];
  for (const action of retractActions) {
    if (!action.expiredAtSet || action.invalidAtSet) {
      violations.push({
        uuid: action.uuid,
        expectation: "retract_only_expired",
        observed: {
          expiredAtSet: action.expiredAtSet,
          invalidAtSet: action.invalidAtSet,
        },
        message: `retract must set expired_at only; got expired_at=${action.expiredAtSet}, invalid_at=${action.invalidAtSet}`,
      });
    }
  }
  for (const action of softDeleteActions) {
    if (!action.expiredAtSet || !action.invalidAtSet) {
      violations.push({
        uuid: action.uuid,
        expectation: "soft_delete_both",
        observed: {
          expiredAtSet: action.expiredAtSet,
          invalidAtSet: action.invalidAtSet,
        },
        message: `soft_delete must set both expired_at and invalid_at; got expired_at=${action.expiredAtSet}, invalid_at=${action.invalidAtSet}`,
      });
    }
  }
  return violations;
}

export type CascadeCheckResult = {
  /** Edges the cascade touched that should have been touched (1-hop). */
  touchedDirectNeighbors: string[];
  /** Edges 1-hop away that the cascade was supposed to touch but didn't. */
  missedDirectNeighbors: string[];
  /** Edges 2+ hops away that the cascade touched (RUNAWAY DEMOTION — failure). */
  touchedTangentialNeighbors: string[];
  /** True when no tangential edges were touched. The single-hop discipline rule. */
  bounded: boolean;
  /** Set-level F1 over the expected-direct set. */
  directNeighborF1: number;
};

/**
 * P0.3b single-hop cascade check.
 *
 * `expectedDirectNeighbors` is the set of edges that should be demoted when
 * the entity is invalidated (its direct attachments). `tangentialEdges` is
 * the set of 2+ hop edges that must NOT be touched. `touched` is the actual
 * list of edges the cascade demoted.
 */
export function assertCascadeBounded(
  touched: readonly string[],
  expectedDirectNeighbors: readonly string[],
  tangentialEdges: readonly string[],
): CascadeCheckResult {
  const touched_ = dedup(touched);
  const expected_ = dedup(expectedDirectNeighbors);
  const tangential_ = dedup(tangentialEdges);
  const expectedSet = new Set(expected_);
  const tangentialSet = new Set(tangential_);
  const touchedSet = new Set(touched_);

  const touchedDirect = touched_.filter((id) => expectedSet.has(id));
  const missedDirect = expected_.filter((id) => !touchedSet.has(id));
  const touchedTangential = touched_.filter((id) => tangentialSet.has(id));

  const setResult = assertExpectedSet(
    touched_.filter((id) => expectedSet.has(id) || tangentialSet.has(id)),
    expected_,
  );

  return {
    touchedDirectNeighbors: touchedDirect,
    missedDirectNeighbors: missedDirect,
    touchedTangentialNeighbors: touchedTangential,
    bounded: touchedTangential.length === 0,
    directNeighborF1: setResult.f1,
  };
}

export type DemotionMetricKey =
  | "set_precision"
  | "set_recall"
  | "set_f1"
  | "timestamp_discipline"
  | "cascade_bounded"
  | "cascade_direct_f1";

export type DemotionMetricScore = {
  metric: DemotionMetricKey;
  value: number;
  weight: number;
};

export type DemotionMatchInput = {
  observedDemotions: readonly string[];
  expectedDemotions: readonly string[];
  retractActions?: readonly DemotionAction[];
  softDeleteActions?: readonly DemotionAction[];
  cascade?: {
    touched: readonly string[];
    expectedDirectNeighbors: readonly string[];
    tangentialEdges: readonly string[];
  };
  weights?: Partial<Record<DemotionMetricKey, number>>;
  passThreshold?: number;
};

export type DemotionMatchResult = {
  metrics: DemotionMetricScore[];
  weightedScore: number;
  passThreshold: number;
  passed: boolean;
  set: SetCheckResult;
  timestampViolations: TimestampViolation[];
  cascade?: CascadeCheckResult;
};

const DEFAULT_DEMOTION_WEIGHTS: Required<Record<DemotionMetricKey, number>> = {
  set_precision: 1,
  set_recall: 1,
  set_f1: 1,
  timestamp_discipline: 1,
  cascade_bounded: 1,
  cascade_direct_f1: 1,
};

const DEFAULT_DEMOTION_THRESHOLD = 0.6;

/**
 * Aggregate the structural side of demotion correctness. The LLM-judged
 * "was this demotion warranted?" half is scored separately via the
 * existing `judgeResponse` path; this returns deterministic metrics that
 * can be asserted in CI without an LLM call.
 */
export function scoreDemotion(input: DemotionMatchInput): DemotionMatchResult {
  const set = assertExpectedSet(
    input.observedDemotions,
    input.expectedDemotions,
  );
  const violations = assertTimestampDiscipline(
    input.retractActions ?? [],
    input.softDeleteActions ?? [],
  );
  const cascade = input.cascade
    ? assertCascadeBounded(
        input.cascade.touched,
        input.cascade.expectedDirectNeighbors,
        input.cascade.tangentialEdges,
      )
    : undefined;

  const timestampScore = violations.length === 0 ? 1 : 0;

  const weights = { ...DEFAULT_DEMOTION_WEIGHTS, ...(input.weights ?? {}) };
  const metrics: DemotionMetricScore[] = [
    {
      metric: "set_precision",
      value: set.precision,
      weight: weights.set_precision,
    },
    { metric: "set_recall", value: set.recall, weight: weights.set_recall },
    { metric: "set_f1", value: set.f1, weight: weights.set_f1 },
    {
      metric: "timestamp_discipline",
      value: timestampScore,
      weight: weights.timestamp_discipline,
    },
  ];
  if (cascade) {
    metrics.push(
      {
        metric: "cascade_bounded",
        value: cascade.bounded ? 1 : 0,
        weight: weights.cascade_bounded,
      },
      {
        metric: "cascade_direct_f1",
        value: cascade.directNeighborF1,
        weight: weights.cascade_direct_f1,
      },
    );
  }

  const totalWeight = metrics.reduce(
    (sum, m) => sum + Math.max(0, m.weight),
    0,
  );
  const weightedScore =
    totalWeight === 0
      ? 0
      : metrics.reduce(
          (sum, m) => (m.weight > 0 ? sum + m.value * m.weight : sum),
          0,
        ) / totalWeight;
  const passThreshold = input.passThreshold ?? DEFAULT_DEMOTION_THRESHOLD;
  const hardFail =
    violations.length > 0 || (cascade !== undefined && !cascade.bounded);
  return {
    metrics,
    weightedScore,
    passThreshold,
    passed: !hardFail && weightedScore >= passThreshold,
    set,
    timestampViolations: violations,
    cascade,
  };
}

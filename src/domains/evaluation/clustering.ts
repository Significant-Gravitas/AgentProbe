/**
 * Pure clustering / partition metrics for the dedup scorer.
 *
 * Given a `predicted` partition (list of clusters of item IDs) and a `golden`
 * partition (the ground-truth clusters), score how well they agree. Used to
 * grade memory-dedup passes: did the dedup pass cluster near-duplicates
 * correctly?
 *
 * Metrics:
 *   - pairwise precision/recall/F1 over the same-cluster relation
 *   - Adjusted Rand Index (Hubert & Arabie 1985) — chance-corrected agreement
 *
 * All functions operate on item IDs (strings). Items present in the predicted
 * partition but absent from the golden one (or vice versa) are treated as
 * singletons in the missing side, so the math degrades gracefully under
 * partial coverage. No I/O.
 */

export type Cluster = readonly string[];
export type Partition = readonly Cluster[];

/**
 * Collect every distinct item across both partitions. Each item appears at
 * most once even when the input clusters contain duplicates.
 */
function collectItems(left: Partition, right: Partition): string[] {
  const seen = new Set<string>();
  for (const cluster of [...left, ...right]) {
    for (const item of cluster) {
      seen.add(item);
    }
  }
  return [...seen].sort();
}

/**
 * Map each item to a numeric cluster id under the partition. Items present in
 * `items` but not assigned a cluster in `partition` are emitted as
 * singleton clusters (each gets its own unique id) so the math degrades
 * gracefully under partial coverage.
 */
function assignClusterIds(
  partition: Partition,
  items: readonly string[],
): Map<string, number> {
  const assignment = new Map<string, number>();
  partition.forEach((cluster, index) => {
    for (const item of cluster) {
      if (!assignment.has(item)) {
        assignment.set(item, index);
      }
    }
  });
  let nextSingletonId = partition.length;
  for (const item of items) {
    if (!assignment.has(item)) {
      assignment.set(item, nextSingletonId);
      nextSingletonId += 1;
    }
  }
  return assignment;
}

export type PairwiseAgreement = {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  trueNegatives: number;
};

/**
 * Build the 2x2 contingency over unordered item pairs:
 *   TP = same cluster in both
 *   FP = same in predicted, different in golden
 *   FN = different in predicted, same in golden
 *   TN = different in both
 */
export function pairwiseAgreement(
  predicted: Partition,
  golden: Partition,
): PairwiseAgreement {
  const items = collectItems(predicted, golden);
  const pred = assignClusterIds(predicted, items);
  const gold = assignClusterIds(golden, items);

  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const left = items[i] ?? "";
      const right = items[j] ?? "";
      const sameInPred = pred.get(left) === pred.get(right);
      const sameInGold = gold.get(left) === gold.get(right);
      if (sameInPred && sameInGold) {
        tp += 1;
      } else if (sameInPred && !sameInGold) {
        fp += 1;
      } else if (!sameInPred && sameInGold) {
        fn += 1;
      } else {
        tn += 1;
      }
    }
  }
  return {
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: fn,
    trueNegatives: tn,
  };
}

export type PairwiseScores = {
  precision: number;
  recall: number;
  f1: number;
};

/**
 * Pairwise precision/recall/F1 over the same-cluster relation. Returns 1 for
 * a metric when its denominator is 0 (the partition has no positive
 * judgments to score). This matches the convention used by `pytrec_eval` and
 * `scikit-learn.metrics.cluster.pair_confusion_matrix`.
 */
export function pairwiseScores(
  predicted: Partition,
  golden: Partition,
): PairwiseScores {
  const { truePositives, falsePositives, falseNegatives } = pairwiseAgreement(
    predicted,
    golden,
  );
  const precision =
    truePositives + falsePositives === 0
      ? 1
      : truePositives / (truePositives + falsePositives);
  const recall =
    truePositives + falseNegatives === 0
      ? 1
      : truePositives / (truePositives + falseNegatives);
  const f1 =
    precision + recall === 0
      ? 0
      : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1 };
}

function choose2(n: number): number {
  return n < 2 ? 0 : (n * (n - 1)) / 2;
}

/**
 * Adjusted Rand Index. Range typically [-0.something, 1]; 0 means agreement
 * at chance level, 1 means perfect agreement, negative means worse than
 * chance. Hubert & Arabie 1985. When both partitions have a single
 * cluster (or all singletons), ARI is defined as 1.
 */
export function adjustedRandIndex(
  predicted: Partition,
  golden: Partition,
): number {
  const items = collectItems(predicted, golden);
  if (items.length < 2) {
    return 1;
  }
  const pred = assignClusterIds(predicted, items);
  const gold = assignClusterIds(golden, items);

  const predIds = [...new Set(pred.values())];
  const goldIds = [...new Set(gold.values())];

  // Contingency matrix counts[i][j] = items in pred cluster i and gold cluster j.
  const counts = new Map<number, Map<number, number>>();
  for (const item of items) {
    const p = pred.get(item) ?? -1;
    const g = gold.get(item) ?? -1;
    let row = counts.get(p);
    if (!row) {
      row = new Map<number, number>();
      counts.set(p, row);
    }
    row.set(g, (row.get(g) ?? 0) + 1);
  }

  const predSizes = predIds.map((id) =>
    items.reduce((sum, item) => (pred.get(item) === id ? sum + 1 : sum), 0),
  );
  const goldSizes = goldIds.map((id) =>
    items.reduce((sum, item) => (gold.get(item) === id ? sum + 1 : sum), 0),
  );

  let index = 0;
  for (const row of counts.values()) {
    for (const value of row.values()) {
      index += choose2(value);
    }
  }

  const sumPredChoose = predSizes.reduce((sum, size) => sum + choose2(size), 0);
  const sumGoldChoose = goldSizes.reduce((sum, size) => sum + choose2(size), 0);
  const total = choose2(items.length);
  if (total === 0) {
    return 1;
  }
  const expected = (sumPredChoose * sumGoldChoose) / total;
  const maxIndex = (sumPredChoose + sumGoldChoose) / 2;
  if (maxIndex === expected) {
    return 1;
  }
  return (index - expected) / (maxIndex - expected);
}

export type ClusterScore = {
  precision: number;
  recall: number;
  f1: number;
  ari: number;
  pairCounts: PairwiseAgreement;
  itemCount: number;
};

export function scoreClustering(
  predicted: Partition,
  golden: Partition,
): ClusterScore {
  const items = collectItems(predicted, golden);
  const { precision, recall, f1 } = pairwiseScores(predicted, golden);
  const ari = adjustedRandIndex(predicted, golden);
  return {
    precision,
    recall,
    f1,
    ari,
    pairCounts: pairwiseAgreement(predicted, golden),
    itemCount: items.length,
  };
}

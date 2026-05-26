import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import type {
  AdapterReply,
  DedupConfig,
  DedupMetricScore,
  DedupScore,
  EvalSource,
  JsonValue,
  Scenario,
} from "../../shared/types/contracts.ts";
import { AgentProbeRuntimeError } from "../../shared/utils/errors.ts";
import { logWarn } from "../../shared/utils/logging.ts";
import { scoreClustering } from "./clustering.ts";

const DEFAULT_RAW_EXCHANGE_KEY = "dedup";

export type DedupPayload = {
  clusters?: string[][];
};

function resolveFixturePath(
  scenariosPath: string | undefined,
  fixture: string,
): string {
  if (isAbsolute(fixture)) {
    return fixture;
  }
  if (!scenariosPath) {
    return resolve(fixture);
  }
  let base: string;
  try {
    base =
      existsSync(scenariosPath) && statSync(scenariosPath).isDirectory()
        ? scenariosPath
        : dirname(scenariosPath);
  } catch {
    base = dirname(scenariosPath);
  }
  return resolve(base, fixture);
}

export function coerceDedupPayload(payload: unknown): DedupPayload {
  if (!payload) {
    return {};
  }
  // Accept `{clusters: [[...], [...]]}` or a bare `[[...], [...]]`.
  if (Array.isArray(payload)) {
    return { clusters: coerceClusters(payload) };
  }
  if (typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    if (Array.isArray(record.clusters)) {
      return { clusters: coerceClusters(record.clusters) };
    }
  }
  return {};
}

function coerceClusters(values: unknown[]): string[][] {
  const clusters: string[][] = [];
  for (const cluster of values) {
    if (!Array.isArray(cluster)) {
      continue;
    }
    const items = cluster.flatMap((item) =>
      typeof item === "string" ? [item] : [],
    );
    if (items.length > 0) {
      clusters.push(items);
    }
  }
  return clusters;
}

export type DedupSourceContext = {
  scenariosPath?: string;
  lastAdapterReply?: AdapterReply;
};

export type ResolvedDedup = {
  payload: DedupPayload;
  source: EvalSource;
};

export function resolveDedupPayload(
  config: DedupConfig,
  context: DedupSourceContext,
): ResolvedDedup {
  const fixture = config.source?.fixture;
  if (fixture) {
    const resolved = resolveFixturePath(context.scenariosPath, fixture);
    if (!existsSync(resolved)) {
      throw new AgentProbeRuntimeError(`Dedup fixture not found: ${resolved}`);
    }
    return {
      payload: coerceDedupPayload(JSON.parse(readFileSync(resolved, "utf8"))),
      source: "fixture",
    };
  }
  const key = config.source?.rawExchangeKey ?? DEFAULT_RAW_EXCHANGE_KEY;
  const rawExchange = context.lastAdapterReply?.rawExchange;
  if (rawExchange && typeof rawExchange === "object") {
    const candidate = (rawExchange as Record<string, JsonValue>)[key];
    if (candidate !== undefined) {
      return {
        payload: coerceDedupPayload(candidate),
        source: "raw_exchange",
      };
    }
  }
  return { payload: {}, source: "missing" };
}

export function scoreScenarioDedup(
  scenario: Scenario,
  context: DedupSourceContext,
): DedupScore | undefined {
  const config = scenario.dedup;
  if (!config) {
    return undefined;
  }

  let resolution: ResolvedDedup;
  try {
    resolution = resolveDedupPayload(config, context);
  } catch (error) {
    logWarn(
      `Dedup scorer failed to resolve payload for ${scenario.id}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    resolution = { payload: {}, source: "missing" };
  }

  const predicted = resolution.payload.clusters ?? [];
  const result = scoreClustering(predicted, config.goldenClusters);

  const metrics: DedupMetricScore[] = [
    {
      metric: "precision",
      value: result.precision,
      weight: config.weights.precision,
    },
    { metric: "recall", value: result.recall, weight: config.weights.recall },
    { metric: "f1", value: result.f1, weight: config.weights.f1 },
    // Map ARI from [-1, 1] to [0, 1] so it composes with the others.
    { metric: "ari", value: (result.ari + 1) / 2, weight: config.weights.ari },
  ];
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

  return {
    metrics,
    weightedScore,
    passThreshold: config.passThreshold,
    passed: weightedScore >= config.passThreshold,
    predictedClusters: predicted.map((c) => [...c]),
    goldenClusters: config.goldenClusters.map((c) => [...c]),
    itemCount: result.itemCount,
    source: resolution.source,
  };
}

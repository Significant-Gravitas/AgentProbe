import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import type {
  AdapterReply,
  JsonValue,
  RetrievalConfig,
  RetrievalScore,
  Scenario,
} from "../../shared/types/contracts.ts";
import { AgentProbeRuntimeError } from "../../shared/utils/errors.ts";
import { logWarn } from "../../shared/utils/logging.ts";
import { scoreRanking } from "./ranking.ts";

const DEFAULT_RAW_EXCHANGE_KEY = "retrieved";

/**
 * Convert a raw exchange/fixture payload into a flat list of strings.
 *
 * Accepts:
 *   - `["item one", "item two"]`
 *   - `[{ label: "foo" }, { id: "bar", label: "bar" }]`
 *   - `[{ name: "foo" }]`  (falls back to `name` then `id`)
 *   - A single string (treated as a one-element list)
 *
 * Anything else returns an empty list and logs a warning — the scorer will
 * then reasonably fail the scenario for missing data, rather than throwing
 * and crashing the whole suite.
 */
export function coerceRetrievedItems(payload: unknown): string[] {
  if (typeof payload === "string") {
    return [payload];
  }
  if (!Array.isArray(payload)) {
    return [];
  }
  const out: string[] = [];
  for (const item of payload) {
    if (typeof item === "string") {
      out.push(item);
      continue;
    }
    if (typeof item === "number" || typeof item === "boolean") {
      out.push(String(item));
      continue;
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const label =
      record.label ??
      record.text ??
      record.title ??
      record.name ??
      record.summary ??
      record.id ??
      record.uuid;
    if (typeof label === "string") {
      out.push(label);
    } else if (typeof label === "number") {
      out.push(String(label));
    }
  }
  return out;
}

/**
 * Resolve a retrieval `source.fixture` path relative to the scenario YAML.
 * When `scenariosPath` is undefined or the scenario was loaded from memory,
 * absolute paths are honored and relative paths are resolved against CWD.
 */
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
    base = existsSync(scenariosPath) && statSync(scenariosPath).isDirectory()
      ? scenariosPath
      : dirname(scenariosPath);
  } catch {
    base = dirname(scenariosPath);
  }
  return resolve(base, fixture);
}

function readFixture(fixturePath: string): unknown {
  const contents = readFileSync(fixturePath, "utf8");
  return JSON.parse(contents) as unknown;
}

export type RetrievalSourceContext = {
  scenariosPath?: string;
  lastAdapterReply?: AdapterReply;
};

export type RetrievedItemsResult = {
  items: string[];
  source: RetrievalScore["source"];
};

/**
 * Resolve the actual list of retrieved items at scoring time.
 *
 * Resolution order:
 *   1. `retrieval.source.fixture` — read JSON file, coerce to strings.
 *   2. `retrieval.source.rawExchangeKey` (or `retrieved` by default) on the
 *      last assistant reply's `rawExchange`.
 *
 * Returns `{ items: [], source: "missing" }` when neither is available so
 * the scorer can record an honest miss rather than guessing.
 */
export function resolveRetrievedItems(
  config: RetrievalConfig,
  context: RetrievalSourceContext,
): RetrievedItemsResult {
  const fixture = config.source?.fixture;
  if (fixture) {
    const resolved = resolveFixturePath(context.scenariosPath, fixture);
    if (!existsSync(resolved)) {
      throw new AgentProbeRuntimeError(
        `Retrieval fixture not found: ${resolved}`,
      );
    }
    const payload = readFixture(resolved);
    const items = coerceRetrievedItems(payload);
    return { items, source: "fixture" };
  }

  const rawExchangeKey = config.source?.rawExchangeKey ?? DEFAULT_RAW_EXCHANGE_KEY;
  const rawExchange = context.lastAdapterReply?.rawExchange;
  if (rawExchange && typeof rawExchange === "object") {
    const candidate = (rawExchange as Record<string, JsonValue>)[rawExchangeKey];
    if (candidate !== undefined) {
      const items = coerceRetrievedItems(candidate);
      return { items, source: "raw_exchange" };
    }
  }

  return { items: [], source: "missing" };
}

/**
 * Score a scenario's retrieval block given a retrieved-list resolution
 * context. Returns `undefined` when the scenario has no retrieval block,
 * otherwise always returns a `RetrievalScore` — including for the `missing`
 * source case (where the score will be 0 and `passed` will be false unless
 * `passThreshold` is 0).
 */
export function scoreRetrieval(
  scenario: Scenario,
  context: RetrievalSourceContext,
): RetrievalScore | undefined {
  const config = scenario.retrieval;
  if (!config) {
    return undefined;
  }

  let resolution: RetrievedItemsResult;
  try {
    resolution = resolveRetrievedItems(config, context);
  } catch (error) {
    logWarn(
      `Retrieval scoring failed to resolve items for scenario ${scenario.id}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    resolution = { items: [], source: "missing" };
  }

  const ranking = scoreRanking({
    returned: resolution.items,
    golden: config.golden,
    forbidden: config.forbidden,
    k: config.k,
    weights: config.weights,
    match: config.match,
    passThreshold: config.passThreshold,
  });

  return {
    k: ranking.k,
    totalRelevant: ranking.totalRelevant,
    totalReturned: ranking.totalReturned,
    hitCount: ranking.hitCount,
    forbiddenHits: ranking.forbiddenHits,
    metrics: ranking.metrics,
    weightedScore: ranking.weightedScore,
    passThreshold: config.passThreshold,
    passed: ranking.passed,
    returned: resolution.items,
    source: resolution.source,
  };
}

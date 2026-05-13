import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import type {
  AdapterReply,
  DemotionAction,
  DemotionConfig,
  DemotionScore,
  EvalSource,
  JsonValue,
  Scenario,
} from "../../shared/types/contracts.ts";
import { AgentProbeRuntimeError } from "../../shared/utils/errors.ts";
import { logWarn } from "../../shared/utils/logging.ts";
import { scoreDemotion } from "./demotion-match.ts";

const DEFAULT_RAW_EXCHANGE_KEY = "demotions";

export type DemotionPayload = {
  /** Observed demotion UUIDs. */
  observed?: string[];
  /** Optional raw retract / soft-delete action records for Snodgrass check. */
  retractActions?: DemotionAction[];
  softDeleteActions?: DemotionAction[];
  /** Observed cascade edge UUIDs. */
  cascadeTouched?: string[];
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

export function coerceDemotionPayload(payload: unknown): DemotionPayload {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {};
  }
  const record = payload as Record<string, unknown>;
  const observed = Array.isArray(record.observed)
    ? record.observed.filter((id): id is string => typeof id === "string")
    : Array.isArray(record.demotions)
      ? record.demotions.filter((id): id is string => typeof id === "string")
      : undefined;
  const cascadeTouched = Array.isArray(record.cascade_touched)
    ? record.cascade_touched.filter(
        (id): id is string => typeof id === "string",
      )
    : undefined;
  const retractActions = Array.isArray(record.retract_actions)
    ? record.retract_actions.flatMap(coerceAction)
    : undefined;
  const softDeleteActions = Array.isArray(record.soft_delete_actions)
    ? record.soft_delete_actions.flatMap(coerceAction)
    : undefined;
  return { observed, cascadeTouched, retractActions, softDeleteActions };
}

function coerceAction(value: unknown): DemotionAction[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  const obj = value as Record<string, unknown>;
  const uuid = typeof obj.uuid === "string" ? obj.uuid : undefined;
  if (!uuid) {
    return [];
  }
  return [
    {
      uuid,
      label: typeof obj.label === "string" ? obj.label : undefined,
      expiredAtSet: obj.expired_at_set === true || obj.expiredAtSet === true,
      invalidAtSet: obj.invalid_at_set === true || obj.invalidAtSet === true,
      status: typeof obj.status === "string" ? obj.status : undefined,
    },
  ];
}

export type DemotionSourceContext = {
  scenariosPath?: string;
  lastAdapterReply?: AdapterReply;
};

export type ResolvedDemotion = {
  payload: DemotionPayload;
  source: EvalSource;
};

export function resolveDemotionPayload(
  config: DemotionConfig,
  context: DemotionSourceContext,
): ResolvedDemotion {
  const fixture = config.source?.fixture;
  if (fixture) {
    const resolved = resolveFixturePath(context.scenariosPath, fixture);
    if (!existsSync(resolved)) {
      throw new AgentProbeRuntimeError(
        `Demotion fixture not found: ${resolved}`,
      );
    }
    return {
      payload: coerceDemotionPayload(
        JSON.parse(readFileSync(resolved, "utf8")),
      ),
      source: "fixture",
    };
  }
  const key = config.source?.rawExchangeKey ?? DEFAULT_RAW_EXCHANGE_KEY;
  const rawExchange = context.lastAdapterReply?.rawExchange;
  if (rawExchange && typeof rawExchange === "object") {
    const candidate = (rawExchange as Record<string, JsonValue>)[key];
    if (candidate !== undefined) {
      return {
        payload: coerceDemotionPayload(candidate),
        source: "raw_exchange",
      };
    }
  }
  return { payload: {}, source: "missing" };
}

export function scoreScenarioDemotion(
  scenario: Scenario,
  context: DemotionSourceContext,
): DemotionScore | undefined {
  const config = scenario.demotion;
  if (!config) {
    return undefined;
  }

  let resolution: ResolvedDemotion;
  try {
    resolution = resolveDemotionPayload(config, context);
  } catch (error) {
    logWarn(
      `Demotion scorer failed to resolve payload for ${scenario.id}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    resolution = { payload: {}, source: "missing" };
  }

  const observed = resolution.payload.observed ?? [];
  const cascadeTouched = resolution.payload.cascadeTouched ?? [];
  const cascadeConfig = config.cascade;
  const cascade = cascadeConfig
    ? {
        touched: cascadeTouched.length > 0 ? cascadeTouched : observed,
        expectedDirectNeighbors: cascadeConfig.expectedDirectNeighbors,
        tangentialEdges: cascadeConfig.tangentialEdges,
      }
    : undefined;

  const match = scoreDemotion({
    observedDemotions: observed,
    expectedDemotions: config.expectedDemotions,
    retractActions: resolution.payload.retractActions,
    softDeleteActions: resolution.payload.softDeleteActions,
    cascade,
    weights: config.weights,
    passThreshold: config.passThreshold,
  });

  return {
    metrics: match.metrics,
    weightedScore: match.weightedScore,
    passThreshold: config.passThreshold,
    passed: match.passed,
    observed,
    expected: [...config.expectedDemotions],
    cascadeBounded: match.cascade?.bounded,
    timestampViolationCount: match.timestampViolations.length,
    source: resolution.source,
  };
}

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import type {
  AdapterReply,
  EvalSource,
  JsonValue,
  ProcedureConfig,
  ProcedureScore,
  Scenario,
} from "../../shared/types/contracts.ts";
import { AgentProbeRuntimeError } from "../../shared/utils/errors.ts";
import { logWarn } from "../../shared/utils/logging.ts";
import { scoreProcedure } from "./procedure-match.ts";

const DEFAULT_RAW_EXCHANGE_KEY = "procedure";

export type ProcedurePayload = {
  steps?: string[];
  parameters?: string[];
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

export function coerceProcedurePayload(payload: unknown): ProcedurePayload {
  if (!payload || typeof payload !== "object") {
    return {};
  }
  if (Array.isArray(payload)) {
    return {
      steps: payload.filter((s): s is string => typeof s === "string"),
    };
  }
  const record = payload as Record<string, unknown>;
  const steps = Array.isArray(record.steps)
    ? record.steps.filter((s): s is string => typeof s === "string")
    : undefined;
  const parameters = Array.isArray(record.parameters)
    ? record.parameters.filter((s): s is string => typeof s === "string")
    : undefined;
  return { steps, parameters };
}

export type ProcedureSourceContext = {
  scenariosPath?: string;
  lastAdapterReply?: AdapterReply;
};

export type ResolvedProcedure = {
  payload: ProcedurePayload;
  source: EvalSource;
};

export function resolveProcedurePayload(
  config: ProcedureConfig,
  context: ProcedureSourceContext,
): ResolvedProcedure {
  const fixture = config.source?.fixture;
  if (fixture) {
    const resolved = resolveFixturePath(context.scenariosPath, fixture);
    if (!existsSync(resolved)) {
      throw new AgentProbeRuntimeError(
        `Procedure fixture not found: ${resolved}`,
      );
    }
    return {
      payload: coerceProcedurePayload(
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
        payload: coerceProcedurePayload(candidate),
        source: "raw_exchange",
      };
    }
  }
  return { payload: {}, source: "missing" };
}

export function scoreScenarioProcedure(
  scenario: Scenario,
  context: ProcedureSourceContext,
): ProcedureScore | undefined {
  const config = scenario.procedure;
  if (!config) {
    return undefined;
  }

  let resolution: ResolvedProcedure;
  try {
    resolution = resolveProcedurePayload(config, context);
  } catch (error) {
    logWarn(
      `Procedure scorer failed to resolve payload for ${scenario.id}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    resolution = { payload: {}, source: "missing" };
  }

  const match = scoreProcedure({
    predictedSteps: resolution.payload.steps ?? [],
    goldenSteps: config.goldenSteps,
    predictedParameters: resolution.payload.parameters,
    goldenParameters: config.goldenParameters,
    weights: config.weights,
    passThreshold: config.passThreshold,
  });

  return {
    metrics: match.metrics,
    weightedScore: match.weightedScore,
    passThreshold: config.passThreshold,
    passed: match.passed,
    predictedSteps: [...(resolution.payload.steps ?? [])],
    goldenSteps: [...config.goldenSteps],
    source: resolution.source,
  };
}

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AdapterReply,
  ProcedureConfig,
  Scenario,
} from "../../shared/types/contracts.ts";
import {
  coerceProcedurePayload,
  resolveProcedurePayload,
  scoreScenarioProcedure,
} from "./procedure-scorer.ts";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `agentprobe-${prefix}-`));
}

function buildConfig(
  overrides: Partial<ProcedureConfig> = {},
): ProcedureConfig {
  return {
    goldenSteps: overrides.goldenSteps ?? ["open ticket", "assign", "close"],
    goldenParameters: overrides.goldenParameters,
    weights: overrides.weights ?? {
      step_coverage: 1,
      step_order: 1,
      parameter_coverage: 1,
    },
    passThreshold: overrides.passThreshold ?? 0.6,
    source: overrides.source,
  };
}

function buildScenario(config: ProcedureConfig | undefined): Scenario {
  return {
    id: "procedure-test",
    name: "Procedure test",
    tags: [],
    turns: [],
    sessions: [],
    expectations: {
      mustInclude: [],
      mustNotInclude: [],
      expectedTools: [],
      failureModes: [],
    },
    procedure: config,
  };
}

function buildReply(payload: unknown): AdapterReply {
  return {
    assistantText: "...",
    toolCalls: [],
    rawExchange: {
      procedure: payload,
    } as unknown as AdapterReply["rawExchange"],
    latencyMs: 0,
    usage: {},
  };
}

describe("coerceProcedurePayload", () => {
  test("accepts a bare list of steps", () => {
    expect(coerceProcedurePayload(["a", "b"]).steps).toEqual(["a", "b"]);
  });

  test("extracts steps and parameters from object payloads", () => {
    const payload = coerceProcedurePayload({
      steps: ["open", "close"],
      parameters: ["ticket_id"],
    });
    expect(payload.steps).toEqual(["open", "close"]);
    expect(payload.parameters).toEqual(["ticket_id"]);
  });
});

describe("resolveProcedurePayload", () => {
  test("loads from fixture", () => {
    const dir = makeTempDir("procedure-fixture");
    writeFileSync(
      join(dir, "proc.json"),
      JSON.stringify({ steps: ["open", "close"] }),
      "utf8",
    );
    const config = buildConfig({ source: { fixture: "proc.json" } });
    const result = resolveProcedurePayload(config, {
      scenariosPath: join(dir, "scenarios.yaml"),
    });
    expect(result.source).toBe("fixture");
    expect(result.payload.steps).toEqual(["open", "close"]);
  });

  test("loads from rawExchange", () => {
    const result = resolveProcedurePayload(buildConfig(), {
      lastAdapterReply: buildReply({ steps: ["a", "b"] }),
    });
    expect(result.source).toBe("raw_exchange");
  });
});

describe("scoreScenarioProcedure", () => {
  test("returns undefined when no procedure block on scenario", () => {
    expect(
      scoreScenarioProcedure(buildScenario(undefined), {}),
    ).toBeUndefined();
  });

  test("perfect match passes", () => {
    const scenario = buildScenario(buildConfig());
    const result = scoreScenarioProcedure(scenario, {
      lastAdapterReply: buildReply({
        steps: ["open ticket", "assign", "close"],
      }),
    });
    expect(result?.weightedScore).toBeCloseTo(1.0, 6);
    expect(result?.passed).toBe(true);
  });

  test("reordered steps drop weighted score", () => {
    const scenario = buildScenario(
      buildConfig({
        weights: { step_coverage: 1, step_order: 5, parameter_coverage: 0 },
      }),
    );
    const result = scoreScenarioProcedure(scenario, {
      lastAdapterReply: buildReply({
        steps: ["close", "assign", "open ticket"],
      }),
    });
    expect(result?.passed).toBe(false);
  });
});

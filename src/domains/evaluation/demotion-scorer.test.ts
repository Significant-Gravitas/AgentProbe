import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AdapterReply,
  DemotionConfig,
  Scenario,
} from "../../shared/types/contracts.ts";
import {
  coerceDemotionPayload,
  resolveDemotionPayload,
  scoreScenarioDemotion,
} from "./demotion-scorer.ts";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `agentprobe-${prefix}-`));
}

function buildConfig(overrides: Partial<DemotionConfig> = {}): DemotionConfig {
  return {
    expectedDemotions: overrides.expectedDemotions ?? ["e1", "e2"],
    expectedRetracts: overrides.expectedRetracts,
    cascade: overrides.cascade,
    weights: overrides.weights ?? {
      set_precision: 1,
      set_recall: 1,
      set_f1: 1,
      timestamp_discipline: 1,
      cascade_bounded: 1,
      cascade_direct_f1: 1,
    },
    passThreshold: overrides.passThreshold ?? 0.6,
    source: overrides.source,
  };
}

function buildScenario(config: DemotionConfig | undefined): Scenario {
  return {
    id: "demotion-test",
    name: "Demotion test",
    tags: [],
    turns: [],
    sessions: [],
    expectations: {
      mustInclude: [],
      mustNotInclude: [],
      expectedTools: [],
      failureModes: [],
    },
    demotion: config,
  };
}

function buildReply(payload: unknown): AdapterReply {
  return {
    assistantText: "...",
    toolCalls: [],
    rawExchange: {
      demotions: payload,
    } as unknown as AdapterReply["rawExchange"],
    latencyMs: 0,
    usage: {},
  };
}

describe("coerceDemotionPayload", () => {
  test("extracts observed UUIDs from `observed` and `demotions` keys", () => {
    expect(coerceDemotionPayload({ observed: ["a", "b"] }).observed).toEqual([
      "a",
      "b",
    ]);
    expect(coerceDemotionPayload({ demotions: ["c"] }).observed).toEqual(["c"]);
  });

  test("extracts cascade and action records", () => {
    const payload = coerceDemotionPayload({
      observed: ["a"],
      cascade_touched: ["e1", "e2"],
      retract_actions: [
        { uuid: "e1", expired_at_set: true, invalid_at_set: false },
      ],
    });
    expect(payload.cascadeTouched).toEqual(["e1", "e2"]);
    expect(payload.retractActions?.[0]?.uuid).toBe("e1");
  });
});

describe("resolveDemotionPayload", () => {
  test("loads fixture relative to scenarios path", () => {
    const dir = makeTempDir("demotion-fixture");
    const fp = join(dir, "demo.json");
    writeFileSync(
      fp,
      JSON.stringify({ observed: ["e1", "e2"], cascade_touched: ["e1"] }),
      "utf8",
    );
    const config = buildConfig({ source: { fixture: "demo.json" } });
    const result = resolveDemotionPayload(config, {
      scenariosPath: join(dir, "scenarios.yaml"),
    });
    expect(result.source).toBe("fixture");
    expect(result.payload.observed).toEqual(["e1", "e2"]);
    expect(result.payload.cascadeTouched).toEqual(["e1"]);
  });

  test("reads from rawExchange when no fixture configured", () => {
    const result = resolveDemotionPayload(buildConfig(), {
      lastAdapterReply: buildReply({ observed: ["e1"] }),
    });
    expect(result.source).toBe("raw_exchange");
    expect(result.payload.observed).toEqual(["e1"]);
  });

  test("missing source returns empty payload", () => {
    expect(resolveDemotionPayload(buildConfig(), {}).source).toBe("missing");
  });
});

describe("scoreScenarioDemotion", () => {
  test("returns undefined when no demotion block on the scenario", () => {
    expect(scoreScenarioDemotion(buildScenario(undefined), {})).toBeUndefined();
  });

  test("perfect demotion passes", () => {
    const scenario = buildScenario(buildConfig());
    const reply = buildReply({ observed: ["e1", "e2"] });
    const result = scoreScenarioDemotion(scenario, { lastAdapterReply: reply });
    expect(result?.passed).toBe(true);
    expect(result?.weightedScore).toBeGreaterThan(0.6);
  });

  test("runaway cascade flips passed to false", () => {
    const scenario = buildScenario(
      buildConfig({
        expectedDemotions: ["e_ab", "e_bc"],
        cascade: {
          expectedDirectNeighbors: ["e_ab", "e_bc"],
          tangentialEdges: ["e_cd"],
        },
      }),
    );
    const reply = buildReply({
      observed: ["e_ab", "e_bc", "e_cd"],
      cascade_touched: ["e_ab", "e_bc", "e_cd"],
    });
    const result = scoreScenarioDemotion(scenario, { lastAdapterReply: reply });
    expect(result?.cascadeBounded).toBe(false);
    expect(result?.passed).toBe(false);
  });

  test("missing source produces a failing score with source=missing", () => {
    const scenario = buildScenario(buildConfig());
    const result = scoreScenarioDemotion(scenario, {});
    expect(result?.source).toBe("missing");
    expect(result?.passed).toBe(false);
  });
});

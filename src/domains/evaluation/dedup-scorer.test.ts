import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AdapterReply,
  DedupConfig,
  Scenario,
} from "../../shared/types/contracts.ts";
import {
  coerceDedupPayload,
  resolveDedupPayload,
  scoreScenarioDedup,
} from "./dedup-scorer.ts";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `agentprobe-${prefix}-`));
}

function buildConfig(overrides: Partial<DedupConfig> = {}): DedupConfig {
  return {
    goldenClusters: overrides.goldenClusters ?? [
      ["a", "b"],
      ["c", "d"],
    ],
    weights: overrides.weights ?? { precision: 1, recall: 1, f1: 1, ari: 1 },
    passThreshold: overrides.passThreshold ?? 0.6,
    source: overrides.source,
  };
}

function buildScenario(config: DedupConfig | undefined): Scenario {
  return {
    id: "dedup-test",
    name: "Dedup test",
    tags: [],
    turns: [],
    sessions: [],
    expectations: {
      mustInclude: [],
      mustNotInclude: [],
      expectedTools: [],
      failureModes: [],
    },
    dedup: config,
  };
}

function buildReply(payload: unknown): AdapterReply {
  return {
    assistantText: "...",
    toolCalls: [],
    rawExchange: { dedup: payload } as unknown as AdapterReply["rawExchange"],
    latencyMs: 0,
    usage: {},
  };
}

describe("coerceDedupPayload", () => {
  test("accepts a bare list of clusters", () => {
    expect(coerceDedupPayload([["a", "b"], ["c"]]).clusters).toEqual([
      ["a", "b"],
      ["c"],
    ]);
  });

  test("accepts {clusters: [[...]]}", () => {
    expect(coerceDedupPayload({ clusters: [["a"], ["b"]] }).clusters).toEqual([
      ["a"],
      ["b"],
    ]);
  });

  test("ignores non-string members and empty clusters", () => {
    expect(
      coerceDedupPayload([["a", 1, null, "b"], [], ["c"]]).clusters,
    ).toEqual([["a", "b"], ["c"]]);
  });
});

describe("resolveDedupPayload", () => {
  test("loads fixture", () => {
    const dir = makeTempDir("dedup-fixture");
    writeFileSync(
      join(dir, "dd.json"),
      JSON.stringify({ clusters: [["a", "b"], ["c"]] }),
      "utf8",
    );
    const config = buildConfig({ source: { fixture: "dd.json" } });
    const result = resolveDedupPayload(config, {
      scenariosPath: join(dir, "scenarios.yaml"),
    });
    expect(result.source).toBe("fixture");
    expect(result.payload.clusters).toEqual([["a", "b"], ["c"]]);
  });
});

describe("scoreScenarioDedup", () => {
  test("returns undefined when no dedup block on scenario", () => {
    expect(scoreScenarioDedup(buildScenario(undefined), {})).toBeUndefined();
  });

  test("perfect match passes with all metrics 1.0 (ARI mapped to 1)", () => {
    const scenario = buildScenario(buildConfig());
    const reply = buildReply({
      clusters: [
        ["a", "b"],
        ["c", "d"],
      ],
    });
    const result = scoreScenarioDedup(scenario, { lastAdapterReply: reply });
    expect(result?.passed).toBe(true);
    expect(result?.weightedScore).toBeCloseTo(1.0, 6);
  });

  test("complete disagreement drops the weighted score below threshold", () => {
    const scenario = buildScenario(buildConfig());
    // Golden: {a, b}, {c, d}. Predicted: {a, c}, {b, d} — pairwise F1=0, ARI=-0.5
    const reply = buildReply({
      clusters: [
        ["a", "c"],
        ["b", "d"],
      ],
    });
    const result = scoreScenarioDedup(scenario, { lastAdapterReply: reply });
    expect(result?.passed).toBe(false);
  });
});

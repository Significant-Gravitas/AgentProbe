import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AdapterReply,
  RetrievalConfig,
  Scenario,
} from "../../shared/types/contracts.ts";
import {
  coerceRetrievedItems,
  resolveRetrievedItems,
  scoreRetrieval,
} from "./retrieval-scorer.ts";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `agentprobe-${prefix}-`));
}

function buildConfig(
  overrides: Partial<RetrievalConfig> = {},
): RetrievalConfig {
  return {
    golden: overrides.golden ?? ["Sarah's email", "Atlas project status"],
    forbidden: overrides.forbidden ?? [],
    k: overrides.k,
    weights: overrides.weights ?? {
      precision_at_k: 1,
      recall_at_k: 1,
      mrr: 1,
      ndcg_at_k: 1,
    },
    passThreshold: overrides.passThreshold ?? 0.5,
    match: overrides.match ?? "substring",
    source: overrides.source,
  };
}

function buildScenario(retrieval: RetrievalConfig | undefined): Scenario {
  return {
    id: "retrieval-test",
    name: "Retrieval Test",
    tags: [],
    turns: [],
    sessions: [],
    expectations: {
      mustInclude: [],
      mustNotInclude: [],
      expectedTools: [],
      failureModes: [],
    },
    retrieval,
  };
}

function buildReply(retrieved: unknown): AdapterReply {
  return {
    assistantText: "...",
    toolCalls: [],
    rawExchange: (retrieved === undefined
      ? {}
      : { retrieved }) as unknown as AdapterReply["rawExchange"],
    latencyMs: 0,
    usage: {},
  };
}

describe("coerceRetrievedItems", () => {
  test("returns the string itself for a single-string payload", () => {
    expect(coerceRetrievedItems("only one")).toEqual(["only one"]);
  });

  test("flattens arrays of strings", () => {
    expect(coerceRetrievedItems(["a", "b"])).toEqual(["a", "b"]);
  });

  test("extracts label/text/name/summary/id from object payloads", () => {
    const payload = [
      { label: "Sarah" },
      { text: "Atlas" },
      { name: "Marcus" },
      { summary: "Northstar" },
      { id: "fact-123" },
    ];
    expect(coerceRetrievedItems(payload)).toEqual([
      "Sarah",
      "Atlas",
      "Marcus",
      "Northstar",
      "fact-123",
    ]);
  });

  test("ignores entries with no recognizable label", () => {
    expect(coerceRetrievedItems([{ irrelevant: 42 }, null, undefined])).toEqual(
      [],
    );
  });

  test("returns [] for non-array, non-string payloads", () => {
    expect(coerceRetrievedItems(42)).toEqual([]);
    expect(coerceRetrievedItems({ foo: "bar" })).toEqual([]);
  });
});

describe("resolveRetrievedItems", () => {
  test("reads a JSON fixture relative to the scenarios path", () => {
    const dir = makeTempDir("retrieval-fixture");
    const fixturePath = join(dir, "memories.json");
    writeFileSync(
      fixturePath,
      JSON.stringify(["Sarah's email", "Atlas project status"]),
      "utf8",
    );

    const config = buildConfig({
      source: { fixture: "memories.json" },
    });

    const result = resolveRetrievedItems(config, {
      scenariosPath: join(dir, "scenarios.yaml"),
    });

    expect(result.source).toBe("fixture");
    expect(result.items).toEqual(["Sarah's email", "Atlas project status"]);
  });

  test("falls back to the default `retrieved` raw exchange key", () => {
    const result = resolveRetrievedItems(buildConfig(), {
      lastAdapterReply: buildReply([{ label: "Sarah" }]),
    });
    expect(result.source).toBe("raw_exchange");
    expect(result.items).toEqual(["Sarah"]);
  });

  test("honors a custom rawExchangeKey", () => {
    const config = buildConfig({
      source: { rawExchangeKey: "memories" },
    });
    const reply: AdapterReply = {
      assistantText: "...",
      toolCalls: [],
      rawExchange: {
        memories: ["A", "B"],
      } as unknown as AdapterReply["rawExchange"],
      latencyMs: 0,
      usage: {},
    };

    const result = resolveRetrievedItems(config, { lastAdapterReply: reply });
    expect(result.items).toEqual(["A", "B"]);
    expect(result.source).toBe("raw_exchange");
  });

  test("returns `missing` source when no fixture or raw exchange field is available", () => {
    const result = resolveRetrievedItems(buildConfig(), {});
    expect(result.source).toBe("missing");
    expect(result.items).toEqual([]);
  });

  test("throws for a missing fixture file", () => {
    const config = buildConfig({
      source: { fixture: "/nonexistent/path/to/file.json" },
    });
    expect(() => resolveRetrievedItems(config, {})).toThrow(
      /Retrieval fixture not found/,
    );
  });
});

describe("scoreRetrieval", () => {
  test("returns undefined when the scenario has no retrieval block", () => {
    expect(scoreRetrieval(buildScenario(undefined), {})).toBeUndefined();
  });

  test("scores a perfect retrieval as passed and weightedScore 1", () => {
    const scenario = buildScenario(buildConfig({ k: 2 }));
    const reply = buildReply(["Sarah's email", "Atlas project status"]);

    const result = scoreRetrieval(scenario, { lastAdapterReply: reply });

    expect(result).toBeDefined();
    expect(result?.source).toBe("raw_exchange");
    expect(result?.hitCount).toBe(2);
    expect(result?.weightedScore).toBeCloseTo(1.0, 6);
    expect(result?.passed).toBe(true);
  });

  test("flags a forbidden hit and forces a fail", () => {
    const scenario = buildScenario(
      buildConfig({
        golden: ["I do not have that"],
        forbidden: ["$50K"],
        k: 3,
        passThreshold: 0.2,
      }),
    );
    const reply = buildReply([
      "I do not have that information",
      "The Q2 marketing budget was $50K",
    ]);

    const result = scoreRetrieval(scenario, { lastAdapterReply: reply });

    expect(result?.hitCount).toBeGreaterThan(0);
    expect(result?.forbiddenHits).toBe(1);
    expect(result?.passed).toBe(false);
  });

  test("missing source records a 0-hit score with source=missing", () => {
    const scenario = buildScenario(buildConfig({ k: 5, passThreshold: 0.5 }));
    const result = scoreRetrieval(scenario, {});

    expect(result?.source).toBe("missing");
    expect(result?.hitCount).toBe(0);
    expect(result?.passed).toBe(false);
  });

  test("loads retrieved items from a fixture relative to the scenarios path", () => {
    const dir = makeTempDir("retrieval-fixture-scored");
    writeFileSync(
      join(dir, "memories.json"),
      JSON.stringify(["Sarah's email", "Atlas project status"]),
      "utf8",
    );
    const scenario = buildScenario(
      buildConfig({
        k: 2,
        source: { fixture: "memories.json" },
      }),
    );

    const result = scoreRetrieval(scenario, {
      scenariosPath: join(dir, "scenarios.yaml"),
    });

    expect(result?.source).toBe("fixture");
    expect(result?.passed).toBe(true);
  });
});

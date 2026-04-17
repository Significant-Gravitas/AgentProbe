import { describe, expect, test } from "bun:test";

import { PostgresRepository } from "../../../src/providers/persistence/postgres-backend.ts";
import type { SqlTag } from "../../../src/providers/persistence/postgres-client.ts";

type Row = Record<string, unknown>;

function presetRow(index: number): Row {
  return {
    id: `preset-${index}`,
    name: `Preset ${index}`,
    description: index % 2 === 0 ? `Description ${index}` : null,
    endpoint: "data/endpoint.yaml",
    personas: "data/personas.yaml",
    rubric: "data/rubric.yaml",
    parallel_enabled: index % 2 === 0,
    parallel_limit: index % 2 === 0 ? 4 : null,
    repeat: index,
    dry_run: index % 3 === 0,
    created_at: "2026-04-17T00:00:00.000Z",
    updated_at: `2026-04-17T00:00:${String(index).padStart(2, "0")}.000Z`,
    deleted_at: null,
  };
}

function runRow(presetId: string, index: number): Row {
  return {
    id: `run-${presetId}`,
    status: "passed",
    passed: true,
    exit_code: 0,
    preset: `Preset ${index}`,
    label: null,
    trigger: "manual",
    cancelled_at: null,
    preset_id: presetId,
    started_at: `2026-04-17T01:00:${String(index).padStart(2, "0")}.000Z`,
    completed_at: null,
    suite_fingerprint: `suite-${index}`,
    final_error_json: null,
    scenario_total: 2,
    scenario_passed_count: 2,
    scenario_failed_count: 0,
    scenario_harness_failed_count: 0,
    scenario_errored_count: 0,
  };
}

function makeCountingSql(presetCount: number): {
  queries: string[];
  sql: SqlTag;
} {
  const presetRows = Array.from({ length: presetCount }, (_, offset) =>
    presetRow(presetCount - offset),
  );
  const selections = [...presetRows].reverse().flatMap((preset) => [
    {
      preset_id: preset.id,
      file: `${preset.id}-suite-a.yaml`,
      scenario_id: `${preset.id}-scenario-a`,
    },
    {
      preset_id: preset.id,
      file: `${preset.id}-suite-b.yaml`,
      scenario_id: `${preset.id}-scenario-b`,
    },
  ]);
  const runs = [...presetRows]
    .reverse()
    .map((preset, index) => runRow(String(preset.id), index + 1));
  const queries: string[] = [];

  const sql = ((stringsOrValues: unknown, ...values: unknown[]) => {
    if (
      (Array.isArray(stringsOrValues) && !("raw" in stringsOrValues)) ||
      (typeof stringsOrValues === "object" &&
        stringsOrValues !== null &&
        !("raw" in stringsOrValues))
    ) {
      return { values: stringsOrValues };
    }

    const text = Array.isArray(stringsOrValues)
      ? stringsOrValues.join("?")
      : String(stringsOrValues);
    queries.push(text.replace(/\s+/g, " ").trim());

    if (text.includes("from preset_scenarios")) {
      return Promise.resolve(selections);
    }
    if (text.includes("from runs")) {
      return Promise.resolve(runs);
    }
    if (text.includes("from presets")) {
      return Promise.resolve(presetRows);
    }

    throw new Error(`Unexpected query: ${text}; values=${values.length}`);
  }) as SqlTag;
  sql.begin = async (fn) => fn(sql);
  sql.unsafe = async () => [];
  sql.end = async () => {};

  return { queries, sql };
}

async function listPresetsWithMockSql(presetCount: number) {
  const { queries, sql } = makeCountingSql(presetCount);
  const repo = new PostgresRepository("postgres://example.invalid/agentprobe");
  Object.defineProperty(repo, "withSql", {
    value: async <T>(fn: (sql: SqlTag) => Promise<T>) => fn(sql),
  });

  return {
    presets: await repo.listPresets(),
    queries,
  };
}

describe("PostgresRepository.listPresets", () => {
  test.each([
    10, 50, 200,
  ])("loads %p presets with a constant query count", async (presetCount) => {
    const { presets, queries } = await listPresetsWithMockSql(presetCount);

    expect(queries).toHaveLength(3);
    expect(queries[0]).toContain("from presets");
    expect(queries[1]).toContain("from preset_scenarios");
    expect(queries[2]).toContain("distinct on (preset_id)");
    expect(presets).toHaveLength(presetCount);
    expect(presets.map((preset) => preset.id)).toEqual(
      Array.from(
        { length: presetCount },
        (_, offset) => `preset-${presetCount - offset}`,
      ),
    );
  });

  test("preserves selection and latest-run fields when batching", async () => {
    const { presets } = await listPresetsWithMockSql(3);
    const preset = presets[0];

    expect(preset).toMatchObject({
      id: "preset-3",
      name: "Preset 3",
      endpoint: "data/endpoint.yaml",
      personas: "data/personas.yaml",
      rubric: "data/rubric.yaml",
      repeat: 3,
      dryRun: true,
      selection: [
        { file: "preset-3-suite-a.yaml", id: "preset-3-scenario-a" },
        { file: "preset-3-suite-b.yaml", id: "preset-3-scenario-b" },
      ],
      lastRun: {
        runId: "run-preset-3",
        presetId: "preset-3",
        status: "passed",
        aggregateCounts: {
          scenarioTotal: 2,
          scenarioPassedCount: 2,
          scenarioFailedCount: 0,
          scenarioHarnessFailedCount: 0,
          scenarioErroredCount: 0,
        },
      },
    });
  });
});

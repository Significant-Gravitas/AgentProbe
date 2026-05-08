import { describe, expect, test } from "bun:test";
import { getTableName } from "drizzle-orm";
import {
  postgresSchema,
  sqliteSchema,
} from "../../../src/providers/persistence/drizzle/index.ts";
import {
  POSTGRES_TARGET_VERSION,
  SQLITE_TARGET_VERSION,
} from "../../../src/providers/persistence/migrations/index.ts";

const expectedTables = [
  "app_settings",
  "checkpoints",
  "endpoint_overrides",
  "human_dimension_scores",
  "judge_dimension_scores",
  "meta",
  "preset_scenarios",
  "presets",
  "runs",
  "scenario_runs",
  "target_events",
  "tool_calls",
  "turns",
];

function schemaTableNames(schema: Record<string, unknown>): string[] {
  return Object.values(schema)
    .map((table) => getTableName(table as never))
    .sort();
}

describe("Drizzle schema mirrors persistence schema contracts", () => {
  test("declares the complete SQLite table inventory for the current target version", () => {
    expect(SQLITE_TARGET_VERSION).toBe(8);
    expect(schemaTableNames(sqliteSchema)).toEqual(expectedTables);
  });

  test("declares the complete Postgres table inventory for the current target version", () => {
    expect(POSTGRES_TARGET_VERSION).toBe(4);
    expect(schemaTableNames(postgresSchema)).toEqual(expectedTables);
  });
});

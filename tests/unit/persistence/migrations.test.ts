import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  checkSchemaVersion,
  POSTGRES_TARGET_VERSION,
  runMigrations,
  SQLITE_TARGET_VERSION,
} from "../../../src/providers/persistence/migrations/index.ts";
import { createPostgresClient } from "../../../src/providers/persistence/postgres-client.ts";
import { makeTempDir } from "../support.ts";
import { withPostgresTestDatabase } from "./postgres-test-utils.ts";

describe("migration dispatcher", () => {
  test("runs SQLite migrations from empty to target version", async () => {
    const dir = makeTempDir("mig-sqlite-empty");
    const url = `sqlite:///${join(dir, "runs.sqlite3")}`;
    const report = await runMigrations(url);
    expect(report.backend).toBe("sqlite");
    expect(report.currentVersion).toBe(0);
    expect(report.targetVersion).toBe(SQLITE_TARGET_VERSION);
    expect(report.applied).toContain(SQLITE_TARGET_VERSION);

    const check = await checkSchemaVersion(url);
    expect(check.currentVersion).toBe(SQLITE_TARGET_VERSION);
  });

  test("is idempotent when already at target version", async () => {
    const dir = makeTempDir("mig-sqlite-idem");
    const url = `sqlite:///${join(dir, "runs.sqlite3")}`;
    await runMigrations(url);
    const second = await runMigrations(url);
    expect(second.currentVersion).toBe(SQLITE_TARGET_VERSION);
    expect(second.applied).toEqual([]);
  });

  test("rejects unsupported URL schemes", async () => {
    await expect(runMigrations("mysql://localhost/x")).rejects.toThrow(
      /Unsupported database URL/,
    );
  });

  test("upgrades an older SQLite schema in place", async () => {
    const dir = makeTempDir("mig-sqlite-upgrade");
    const path = join(dir, "runs.sqlite3");
    const db = new Database(path);
    db.exec(`
      create table meta (
        id integer primary key,
        schema_version integer not null,
        created_at text not null
      );
      insert into meta (id, schema_version, created_at) values (1, 1, '2026-04-17T00:00:00Z');
      create table runs (
        id text primary key,
        status text not null,
        started_at text not null,
        updated_at text not null
      );
      create table scenario_runs (
        id integer primary key autoincrement,
        run_id text not null,
        ordinal integer not null,
        scenario_id text not null,
        scenario_name text not null,
        persona_id text not null,
        rubric_id text not null,
        status text not null,
        started_at text not null,
        updated_at text not null
      );
    `);
    db.close();

    const url = `sqlite:///${path}`;
    const report = await runMigrations(url);
    expect(report.currentVersion).toBe(1);
    expect(report.applied).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect(report.targetVersion).toBe(SQLITE_TARGET_VERSION);
  });

  test("upgrades Postgres v2 schema with settings and overrides tables", async () => {
    await withPostgresTestDatabase(async (url) => {
      const sql = createPostgresClient(url);
      try {
        await sql.unsafe(`
          drop table if exists app_settings, endpoint_overrides cascade;
          update meta set schema_version = 2 where id = 1;
        `);
      } finally {
        await sql.end?.();
      }

      const report = await runMigrations(url);
      expect(report.currentVersion).toBe(2);
      expect(report.applied).toEqual([3, 4]);
      expect(report.targetVersion).toBe(POSTGRES_TARGET_VERSION);

      const check = await checkSchemaVersion(url);
      expect(check.currentVersion).toBe(POSTGRES_TARGET_VERSION);
    });
  });
});

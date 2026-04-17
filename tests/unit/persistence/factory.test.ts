import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  createRecordingRepository,
  createRepository,
} from "../../../src/providers/persistence/factory.ts";
import { PostgresRepository } from "../../../src/providers/persistence/postgres-backend.ts";
import { SqliteRepository } from "../../../src/providers/persistence/sqlite-backend.ts";
import { initDb } from "../../../src/providers/persistence/sqlite-run-history.ts";
import { makeTempDir } from "../support.ts";

describe("createRepository factory", () => {
  test("returns SqliteRepository for sqlite URLs", async () => {
    const dir = makeTempDir("factory-sqlite");
    const url = `sqlite:///${join(dir, "runs.sqlite3")}`;
    initDb(url);
    const repo = createRepository(url);
    expect(repo).toBeInstanceOf(SqliteRepository);
    expect(repo.kind).toBe("sqlite");
    // @ts-expect-error createRepository returns the non-recording interface.
    void repo.createRecorder;
    // Async listRuns works on empty DB.
    await expect(repo.listRuns()).resolves.toEqual([]);
  });

  test("returns PostgresRepository for postgres URLs", () => {
    const repo = createRepository("postgres://u:p@localhost/agentprobe");
    expect(repo).toBeInstanceOf(PostgresRepository);
    expect(repo.kind).toBe("postgres");
    // @ts-expect-error PostgresRepository is not recording-capable.
    void repo.createRecorder;
  });

  test("rejects unsupported schemes", () => {
    expect(() => createRepository("mysql://h/db")).toThrow(
      /Unsupported database URL/,
    );
  });

  test("createRecordingRepository returns sqlite and rejects postgres", () => {
    const dir = makeTempDir("factory-recording");
    const url = `sqlite:///${join(dir, "runs.sqlite3")}`;
    initDb(url);
    const repo = createRecordingRepository(url);
    expect(repo).toBeInstanceOf(SqliteRepository);
    expect(repo.createRecorder()).toBeDefined();

    expect(() =>
      createRecordingRepository("postgres://localhost/agentprobe"),
    ).toThrow(/Postgres is read-only for run recording/);
  });
});

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { createRepository } from "../../../src/providers/persistence/factory.ts";
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
    // Async listRuns works on empty DB.
    await expect(repo.listRuns()).resolves.toEqual([]);
  });

  test("returns PostgresRepository for postgres URLs", () => {
    const repo = createRepository("postgres://u:p@localhost/agentprobe");
    expect(repo).toBeInstanceOf(PostgresRepository);
    expect(repo.kind).toBe("postgres");
  });

  test("rejects unsupported schemes", () => {
    expect(() => createRepository("mysql://h/db")).toThrow(
      /Unsupported database URL/,
    );
  });

  test("PostgresRepository.createRecorder returns a buffered recorder", async () => {
    const repo = createRepository("postgres://localhost/agentprobe");
    const recorder = repo.createRecorder();
    expect(typeof recorder.recordRunStarted).toBe("function");
    expect(typeof recorder.drain).toBe("function");
    await recorder.close?.();
  });
});

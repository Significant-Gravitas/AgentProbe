import { describe, expect, test } from "bun:test";

import {
  isPostgresUrl,
  parseDbUrl,
  redactDbUrl,
} from "../../../src/providers/persistence/url.ts";

describe("persistence url helpers", () => {
  test("redacts postgres credentials", () => {
    expect(redactDbUrl("postgres://user:hunter2@host:5432/db")).toBe(
      "postgres://user:***@host:5432/db",
    );
    expect(redactDbUrl("postgresql://alice:secret@h/db")).toBe(
      "postgresql://alice:***@h/db",
    );
  });

  test("redacts postgres passwords containing reserved or encoded characters", () => {
    expect(redactDbUrl("postgres://user:pa@ss@host:5432/db")).toBe(
      "postgres://user:***@host:5432/db",
    );
    expect(redactDbUrl("postgres://user:pa:ss@host/db")).toBe(
      "postgres://user:***@host/db",
    );
    expect(redactDbUrl("postgres://user:pa/ss@host/db")).toBe(
      "postgres://user:***@host/db",
    );
    expect(redactDbUrl("postgres://user:p%2Fss@host/db")).toBe(
      "postgres://user:***@host/db",
    );
    expect(redactDbUrl("postgres://user:p%25ss@host/db")).toBe(
      "postgres://user:***@host/db",
    );
  });

  test("leaves username-only userinfo unchanged", () => {
    expect(redactDbUrl("postgres://user@host/db")).toBe(
      "postgres://user@host/db",
    );
  });

  test("redacts credentials for non-postgres URL schemes", () => {
    expect(redactDbUrl("mysql://user:pa@ss@host/db")).toBe(
      "mysql://user:***@host/db",
    );
  });

  test("passes through sqlite URLs unchanged", () => {
    expect(redactDbUrl("sqlite:///tmp/runs.sqlite3")).toBe(
      "sqlite:///tmp/runs.sqlite3",
    );
  });

  test("parseDbUrl classifies schemes", () => {
    expect(parseDbUrl("sqlite:///tmp/x.db").kind).toBe("sqlite");
    expect(parseDbUrl("postgres://u:p@h/db").kind).toBe("postgres");
    expect(parseDbUrl("postgresql://u:p@h/db").kind).toBe("postgres");
    expect(parseDbUrl("postgresql://u:p@h/db").displayUrl).toBe(
      "postgresql://u:***@h/db",
    );
    expect(parseDbUrl("postgresql://u:pa@ss@h/db").displayUrl).toBe(
      "postgresql://u:***@h/db",
    );
  });

  test("parseDbUrl rejects unsupported schemes", () => {
    expect(() => parseDbUrl("mysql://h/db")).toThrow(
      /Unsupported database URL/,
    );
    expect(() => parseDbUrl("")).toThrow(/non-empty/);
  });

  test("isPostgresUrl recognizes both aliases", () => {
    expect(isPostgresUrl("postgres://h/db")).toBe(true);
    expect(isPostgresUrl("postgresql://h/db")).toBe(true);
    expect(isPostgresUrl("sqlite:///x")).toBe(false);
  });
});

import { describe, expect, test } from "bun:test";

import type { ServerConfig } from "../../../../src/runtime/server/config.ts";
import {
  isSecretKey,
  redactRecord,
  redactSecretValue,
  summarizeServerConfig,
} from "../../../../src/runtime/server/observability/redaction.ts";

describe("redaction", () => {
  test("redactSecretValue masks long secrets and keeps length signal", () => {
    expect(redactSecretValue("abcd1234")).toBe("[redacted]:8c");
    expect(redactSecretValue("ab")).toBe("[redacted]");
    expect(redactSecretValue(undefined)).toBe("");
    expect(redactSecretValue(null)).toBe("");
  });

  test("isSecretKey covers common credential patterns", () => {
    expect(isSecretKey("token")).toBeTrue();
    expect(isSecretKey("api_key")).toBeTrue();
    expect(isSecretKey("Authorization")).toBeTrue();
    expect(isSecretKey("port")).toBeFalse();
  });

  test("redactRecord redacts nested secret keys", () => {
    const out = redactRecord({
      host: "127.0.0.1",
      auth: { token: "supersecretvalue", scope: "read" },
    });
    expect(out.host).toBe("127.0.0.1");
    const auth = out.auth as Record<string, unknown>;
    expect(auth.token).toBe("[redacted]:16c");
    expect(auth.scope).toBe("read");
  });

  test("summarizeServerConfig redacts token and db url", () => {
    const config: ServerConfig = {
      host: "127.0.0.1",
      port: 7878,
      dataPath: "/tmp/data",
      dbUrl: "postgres://user:secretpw@db.example/agentprobe",
      dashboardDist: undefined,
      token: "tok_super_long_value",
      corsOrigins: [],
      unsafeExpose: false,
      openBrowser: false,
      logFormat: "json",
    };
    const summary = summarizeServerConfig(config);
    expect(summary.token).toBe("[redacted]:20c");
    expect(String(summary.db_url)).not.toContain("secretpw");
  });
});

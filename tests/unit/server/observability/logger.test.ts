import { describe, expect, test } from "bun:test";

import { createLogger } from "../../../../src/runtime/server/observability/logger.ts";

describe("createLogger", () => {
  test("emits JSON lines with merged base fields", () => {
    const lines: string[] = [];
    const logger = createLogger({
      component: "agentprobe.server",
      format: "json",
      sink: (line) => lines.push(line),
      baseFields: { request_id: "rid-1" },
    });
    logger.info("http.request", { method: "GET", status: 200 });
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] ?? "");
    expect(parsed.event).toBe("http.request");
    expect(parsed.component).toBe("agentprobe.server");
    expect(parsed.request_id).toBe("rid-1");
    expect(parsed.method).toBe("GET");
    expect(parsed.status).toBe(200);
    expect(parsed.level).toBe("info");
  });

  test("text format emits component, level, event prefix", () => {
    const lines: string[] = [];
    const logger = createLogger({
      component: "agentprobe.run",
      format: "text",
      sink: (line) => lines.push(line),
    });
    logger.error("run.error", { run_id: "abc" });
    expect(lines[0]).toContain("[agentprobe.run]");
    expect(lines[0]).toContain("error");
    expect(lines[0]).toContain("run.error");
    expect(lines[0]).toContain("run_id=abc");
  });

  test("child loggers inherit base fields and override component", () => {
    const lines: string[] = [];
    const parent = createLogger({
      component: "agentprobe.server",
      format: "json",
      sink: (line) => lines.push(line),
      baseFields: { request_id: "rid-1" },
    });
    const child = parent.child("agentprobe.run", { run_id: "abc" });
    child.warn("run.slow", { duration_ms: 1500 });
    const parsed = JSON.parse(lines[0] ?? "");
    expect(parsed.component).toBe("agentprobe.run");
    expect(parsed.request_id).toBe("rid-1");
    expect(parsed.run_id).toBe("abc");
    expect(parsed.duration_ms).toBe(1500);
    expect(parsed.level).toBe("warn");
  });
});

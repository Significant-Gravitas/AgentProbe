import { describe, expect, test } from "bun:test";

import {
  SERVER_SPAN_NAMES,
  SpanRecorder,
} from "../../../../src/runtime/server/observability/spans.ts";

describe("SpanRecorder", () => {
  test("records duration and ok status for synchronous work", () => {
    const recorder = new SpanRecorder();
    const scope = recorder.start(SERVER_SPAN_NAMES.runStartValidation, {
      preset_id: "preset-1",
    });
    scope.setAttribute("note", "ok");
    scope.setStatus("ok");
    scope.end();
    const records = recorder.snapshot();
    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record).toBeDefined();
    if (!record) return;
    expect(record.name).toBe(SERVER_SPAN_NAMES.runStartValidation);
    expect(record.status).toBe("ok");
    expect(record.attributes).toMatchObject({
      preset_id: "preset-1",
      note: "ok",
    });
    expect(record.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("withSpan captures errors and rethrows", async () => {
    const recorder = new SpanRecorder();
    await expect(
      recorder.withSpan("server.test", {}, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const records = recorder.snapshot();
    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record).toBeDefined();
    if (!record) return;
    expect(record.status).toBe("error");
    expect(record.error?.message).toBe("boom");
  });

  test("end is idempotent", () => {
    const recorder = new SpanRecorder();
    const scope = recorder.start("s");
    scope.end();
    scope.end();
    expect(recorder.snapshot()).toHaveLength(1);
  });
});

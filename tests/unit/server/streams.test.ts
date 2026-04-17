import { describe, expect, test } from "bun:test";

import {
  formatSseEvent,
  formatSseKeepalive,
} from "../../../src/runtime/server/streams/events.ts";
import { StreamHub } from "../../../src/runtime/server/streams/hub.ts";

describe("server streams", () => {
  test("keeps a bounded per-run replay buffer", () => {
    const hub = new StreamHub({ capacity: 2 });

    hub.publish({ runId: "run-1", kind: "log", payload: { index: 1 } });
    const second = hub.publish({
      runId: "run-1",
      kind: "run_progress",
      payload: { index: 2 },
    });
    const third = hub.publish({
      runId: "run-1",
      kind: "run_finished",
      payload: { index: 3 },
    });

    expect(hub.bufferSize("run-1")).toBe(2);
    expect(hub.replay("run-1").map((event) => event.id)).toEqual([
      second.id,
      third.id,
    ]);
    expect(hub.replay("run-1", second.id)).toEqual([third]);
  });

  test("formats normalized SSE envelopes", () => {
    const event = {
      id: 7,
      runId: "run-1",
      kind: "snapshot" as const,
      payload: { status: "completed" },
      createdAt: "2026-04-17T00:00:00.000Z",
    };

    const text = formatSseEvent(event);
    expect(text).toContain("id: 7\n");
    expect(text).toContain("event: snapshot\n");
    expect(text).toContain('"run_id":"run-1"');
    expect(text).toContain('"created_at":"2026-04-17T00:00:00.000Z"');
    expect(formatSseKeepalive()).toStartWith(": keepalive ");
  });
});

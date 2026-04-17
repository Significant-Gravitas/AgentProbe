import { describe, expect, test } from "bun:test";

import {
  MetricsRegistry,
  SERVER_METRIC_NAMES,
} from "../../../../src/runtime/server/observability/metrics.ts";

describe("MetricsRegistry", () => {
  test("increments counters and groups by labels", () => {
    const metrics = new MetricsRegistry();
    metrics.incrementCounter(SERVER_METRIC_NAMES.httpRequests, 1, {
      method: "GET",
      route: "/api/runs",
      status: 200,
    });
    metrics.incrementCounter(SERVER_METRIC_NAMES.httpRequests, 1, {
      method: "GET",
      route: "/api/runs",
      status: 200,
    });
    metrics.incrementCounter(SERVER_METRIC_NAMES.httpRequests, 1, {
      method: "POST",
      route: "/api/runs",
      status: 202,
    });

    expect(
      metrics.getCounter(SERVER_METRIC_NAMES.httpRequests, {
        method: "GET",
        route: "/api/runs",
        status: 200,
      }),
    ).toBe(2);
    const snapshot = metrics.snapshot();
    const requestCounters = snapshot.counters.filter(
      (entry) => entry.name === SERVER_METRIC_NAMES.httpRequests,
    );
    expect(requestCounters).toHaveLength(2);
  });

  test("gauges track active and total separately", () => {
    const metrics = new MetricsRegistry();
    metrics.adjustGauge(SERVER_METRIC_NAMES.runsActive, 1);
    metrics.adjustGauge(SERVER_METRIC_NAMES.runsActive, 1);
    metrics.adjustGauge(SERVER_METRIC_NAMES.runsActive, -1);
    metrics.incrementCounter(SERVER_METRIC_NAMES.runsStartedTotal, 1);
    metrics.incrementCounter(SERVER_METRIC_NAMES.runsFinishedTotal, 1);

    expect(metrics.getGauge(SERVER_METRIC_NAMES.runsActive)).toBe(1);
    expect(metrics.getCounter(SERVER_METRIC_NAMES.runsStartedTotal)).toBe(1);
    expect(metrics.getCounter(SERVER_METRIC_NAMES.runsFinishedTotal)).toBe(1);
  });

  test("snapshot is sorted by name", () => {
    const metrics = new MetricsRegistry();
    metrics.incrementCounter("z.alpha", 1);
    metrics.incrementCounter("a.alpha", 1);
    const snapshot = metrics.snapshot();
    expect(snapshot.counters.map((entry) => entry.name)).toEqual([
      "a.alpha",
      "z.alpha",
    ]);
  });

  test("reset clears all state", () => {
    const metrics = new MetricsRegistry();
    metrics.incrementCounter("c", 5);
    metrics.setGauge("g", 3);
    metrics.reset();
    expect(metrics.snapshot().counters).toEqual([]);
    expect(metrics.snapshot().gauges).toEqual([]);
  });
});

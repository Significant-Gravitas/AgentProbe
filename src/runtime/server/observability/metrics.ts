export type MetricLabels = Readonly<Record<string, string | number | boolean>>;

export type CounterSnapshot = {
  name: string;
  value: number;
  labels: Record<string, string | number | boolean>;
};

export type GaugeSnapshot = CounterSnapshot;

export type MetricsSnapshot = {
  counters: CounterSnapshot[];
  gauges: GaugeSnapshot[];
};

function labelKey(labels: MetricLabels | undefined): string {
  if (!labels) return "";
  const entries = Object.entries(labels)
    .map(([k, v]) => [k, String(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return entries.map(([k, v]) => `${k}=${v}`).join("|");
}

function cloneLabels(labels: MetricLabels | undefined): MetricLabels {
  if (!labels) return {};
  return { ...labels };
}

export class MetricsRegistry {
  private readonly counters = new Map<string, Map<string, number>>();
  private readonly counterLabels = new Map<string, Map<string, MetricLabels>>();
  private readonly gauges = new Map<string, Map<string, number>>();
  private readonly gaugeLabels = new Map<string, Map<string, MetricLabels>>();

  incrementCounter(name: string, value = 1, labels?: MetricLabels): void {
    const key = labelKey(labels);
    let perName = this.counters.get(name);
    if (!perName) {
      perName = new Map();
      this.counters.set(name, perName);
    }
    perName.set(key, (perName.get(key) ?? 0) + value);
    let labelMap = this.counterLabels.get(name);
    if (!labelMap) {
      labelMap = new Map();
      this.counterLabels.set(name, labelMap);
    }
    if (!labelMap.has(key)) {
      labelMap.set(key, cloneLabels(labels));
    }
  }

  setGauge(name: string, value: number, labels?: MetricLabels): void {
    const key = labelKey(labels);
    let perName = this.gauges.get(name);
    if (!perName) {
      perName = new Map();
      this.gauges.set(name, perName);
    }
    perName.set(key, value);
    let labelMap = this.gaugeLabels.get(name);
    if (!labelMap) {
      labelMap = new Map();
      this.gaugeLabels.set(name, labelMap);
    }
    if (!labelMap.has(key)) {
      labelMap.set(key, cloneLabels(labels));
    }
  }

  adjustGauge(name: string, delta: number, labels?: MetricLabels): void {
    const key = labelKey(labels);
    let perName = this.gauges.get(name);
    if (!perName) {
      perName = new Map();
      this.gauges.set(name, perName);
    }
    perName.set(key, (perName.get(key) ?? 0) + delta);
    let labelMap = this.gaugeLabels.get(name);
    if (!labelMap) {
      labelMap = new Map();
      this.gaugeLabels.set(name, labelMap);
    }
    if (!labelMap.has(key)) {
      labelMap.set(key, cloneLabels(labels));
    }
  }

  getCounter(name: string, labels?: MetricLabels): number {
    const key = labelKey(labels);
    return this.counters.get(name)?.get(key) ?? 0;
  }

  getGauge(name: string, labels?: MetricLabels): number {
    const key = labelKey(labels);
    return this.gauges.get(name)?.get(key) ?? 0;
  }

  snapshot(): MetricsSnapshot {
    const counters: CounterSnapshot[] = [];
    for (const [name, perName] of this.counters.entries()) {
      const labelMap = this.counterLabels.get(name);
      for (const [key, value] of perName.entries()) {
        counters.push({
          name,
          value,
          labels: { ...(labelMap?.get(key) ?? {}) },
        });
      }
    }
    const gauges: GaugeSnapshot[] = [];
    for (const [name, perName] of this.gauges.entries()) {
      const labelMap = this.gaugeLabels.get(name);
      for (const [key, value] of perName.entries()) {
        gauges.push({
          name,
          value,
          labels: { ...(labelMap?.get(key) ?? {}) },
        });
      }
    }
    return {
      counters: counters.sort((a, b) => a.name.localeCompare(b.name)),
      gauges: gauges.sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  reset(): void {
    this.counters.clear();
    this.counterLabels.clear();
    this.gauges.clear();
    this.gaugeLabels.clear();
  }
}

export const SERVER_METRIC_NAMES = {
  httpRequests: "server.http.requests",
  runsActive: "server.runs.active",
  runsStartedTotal: "server.runs.started_total",
  runsFinishedTotal: "server.runs.finished_total",
  sseConnections: "server.sse.connections",
} as const;

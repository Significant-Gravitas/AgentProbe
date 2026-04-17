import type { LogFormat } from "../config.ts";
import { createLogger, type Logger } from "./logger.ts";
import { MetricsRegistry, SERVER_METRIC_NAMES } from "./metrics.ts";
import { SERVER_SPAN_NAMES, SpanRecorder } from "./spans.ts";

export type Observability = {
  logger: Logger;
  metrics: MetricsRegistry;
  spans: SpanRecorder;
};

export function createObservability(options: {
  format: LogFormat;
  component?: string;
  metrics?: MetricsRegistry;
  spans?: SpanRecorder;
}): Observability {
  const logger = createLogger({
    component: options.component ?? "agentprobe.server",
    format: options.format,
  });
  return {
    logger,
    metrics: options.metrics ?? new MetricsRegistry(),
    spans: options.spans ?? new SpanRecorder(),
  };
}

export type { LogFields, Logger, LogLevel } from "./logger.ts";
export { createLogger } from "./logger.ts";
export type {
  CounterSnapshot,
  GaugeSnapshot,
  MetricLabels,
  MetricsSnapshot,
} from "./metrics.ts";
export { MetricsRegistry, SERVER_METRIC_NAMES } from "./metrics.ts";
export {
  isSecretKey,
  redactRecord,
  redactSecretValue,
  summarizeServerConfig,
} from "./redaction.ts";
export type { SpanRecord, SpanScope } from "./spans.ts";
export { SERVER_SPAN_NAMES, SpanRecorder } from "./spans.ts";

export const METRIC_NAMES = SERVER_METRIC_NAMES;
export const SPAN_NAMES = SERVER_SPAN_NAMES;

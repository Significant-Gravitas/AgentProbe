export type SpanRecord = {
  name: string;
  startedAt: number;
  durationMs: number;
  attributes: Record<string, unknown>;
  status: "ok" | "error";
  error?: { type: string; message: string };
};

export type SpanScope = {
  setAttribute(key: string, value: unknown): void;
  setStatus(status: "ok" | "error", error?: Error): void;
  end(): void;
  readonly name: string;
  readonly startedAt: number;
};

export class SpanRecorder {
  private readonly records: SpanRecord[] = [];
  private readonly capacity: number;

  constructor(options: { capacity?: number } = {}) {
    this.capacity = options.capacity ?? 1024;
  }

  start(name: string, attributes: Record<string, unknown> = {}): SpanScope {
    const startedAt = performance.now();
    const attrs: Record<string, unknown> = { ...attributes };
    let status: "ok" | "error" = "ok";
    let recordedError: Error | undefined;
    let ended = false;

    const finalize = (): void => {
      if (ended) return;
      ended = true;
      const record: SpanRecord = {
        name,
        startedAt,
        durationMs: performance.now() - startedAt,
        attributes: { ...attrs },
        status,
      };
      if (status === "error" && recordedError) {
        record.error = {
          type: recordedError.name || "Error",
          message: recordedError.message,
        };
      }
      this.records.push(record);
      if (this.records.length > this.capacity) {
        this.records.splice(0, this.records.length - this.capacity);
      }
    };

    return {
      name,
      startedAt,
      setAttribute(key: string, value: unknown): void {
        attrs[key] = value;
      },
      setStatus(next: "ok" | "error", error?: Error): void {
        status = next;
        if (error) {
          recordedError = error;
        }
      },
      end: finalize,
    };
  }

  async withSpan<T>(
    name: string,
    attributes: Record<string, unknown>,
    fn: (scope: SpanScope) => Promise<T> | T,
  ): Promise<T> {
    const scope = this.start(name, attributes);
    try {
      const result = await fn(scope);
      scope.setStatus("ok");
      return result;
    } catch (error) {
      scope.setStatus(
        "error",
        error instanceof Error ? error : new Error(String(error)),
      );
      throw error;
    } finally {
      scope.end();
    }
  }

  snapshot(): SpanRecord[] {
    return this.records.map((record) => ({
      ...record,
      attributes: { ...record.attributes },
    }));
  }

  reset(): void {
    this.records.length = 0;
  }
}

export const SERVER_SPAN_NAMES = {
  runStartValidation: "server.run.start.validation",
  runControllerExecute: "server.run.controller.execute",
  runSuiteBoot: "server.run.suite.boot",
} as const;

import type { JsonValue } from "../../../shared/types/contracts.ts";
import type { RunEvent, RunEventKind } from "./events.ts";

export const DEFAULT_RING_BUFFER_SIZE = 256;

type Subscriber = (event: RunEvent) => void;

type RunBuffer = {
  nextId: number;
  ring: RunEvent[];
  capacity: number;
  subscribers: Set<Subscriber>;
};

export type PublishOptions = {
  runId: string;
  kind: RunEventKind;
  payload: JsonValue;
  createdAt?: string;
};

export class StreamHub {
  private readonly runs = new Map<string, RunBuffer>();
  private readonly capacity: number;

  constructor(options: { capacity?: number } = {}) {
    this.capacity = options.capacity ?? DEFAULT_RING_BUFFER_SIZE;
  }

  private getOrCreateBuffer(runId: string): RunBuffer {
    let buffer = this.runs.get(runId);
    if (!buffer) {
      buffer = {
        nextId: 1,
        ring: [],
        capacity: this.capacity,
        subscribers: new Set(),
      };
      this.runs.set(runId, buffer);
    }
    return buffer;
  }

  publish(options: PublishOptions): RunEvent {
    const buffer = this.getOrCreateBuffer(options.runId);
    const event: RunEvent = {
      id: buffer.nextId,
      runId: options.runId,
      kind: options.kind,
      payload: options.payload,
      createdAt: options.createdAt ?? new Date().toISOString(),
    };
    buffer.nextId += 1;
    buffer.ring.push(event);
    if (buffer.ring.length > buffer.capacity) {
      buffer.ring.splice(0, buffer.ring.length - buffer.capacity);
    }
    for (const subscriber of buffer.subscribers) {
      try {
        subscriber(event);
      } catch {
        // subscriber errors are isolated per-listener
      }
    }
    return event;
  }

  replay(runId: string, afterId?: number): RunEvent[] {
    const buffer = this.runs.get(runId);
    if (!buffer) {
      return [];
    }
    if (afterId === undefined || afterId <= 0) {
      return [...buffer.ring];
    }
    return buffer.ring.filter((event) => event.id > afterId);
  }

  latestId(runId: string): number {
    const buffer = this.runs.get(runId);
    if (!buffer || buffer.ring.length === 0) {
      return 0;
    }
    return buffer.ring[buffer.ring.length - 1]?.id ?? 0;
  }

  subscribe(runId: string, subscriber: Subscriber): () => void {
    const buffer = this.getOrCreateBuffer(runId);
    buffer.subscribers.add(subscriber);
    return () => {
      buffer.subscribers.delete(subscriber);
    };
  }

  clear(runId: string): void {
    this.runs.delete(runId);
  }

  bufferSize(runId: string): number {
    return this.runs.get(runId)?.ring.length ?? 0;
  }
}

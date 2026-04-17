import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RunDetailView } from "../../dashboard/src/App.tsx";

type SseListener = () => void;

class MockEventSource {
  static instances: MockEventSource[] = [];

  readonly listeners = new Map<string, SseListener[]>();
  closed = false;

  constructor(readonly url: string) {
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: SseListener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener();
    }
  }

  close(): void {
    this.closed = true;
  }
}

type PendingRequest = {
  path: string;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

let root: Root | undefined;
let container: HTMLDivElement;
let previousWindow: typeof globalThis.window | undefined;
let previousDocument: typeof globalThis.document | undefined;
let previousNavigator: typeof globalThis.navigator | undefined;
let previousElement: typeof globalThis.Element | undefined;
let previousHTMLElement: typeof globalThis.HTMLElement | undefined;
let previousEventSource: typeof globalThis.EventSource | undefined;
let previousActEnvironment: unknown;

function installDom(): void {
  const window = new Window({ url: "http://localhost/runs/run-a" });
  previousWindow = globalThis.window;
  previousDocument = globalThis.document;
  previousNavigator = globalThis.navigator;
  previousElement = globalThis.Element;
  previousHTMLElement = globalThis.HTMLElement;
  previousEventSource = globalThis.EventSource;
  previousActEnvironment = (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }
  ).IS_REACT_ACT_ENVIRONMENT;

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: window,
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    writable: true,
    value: window.document,
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    writable: true,
    value: window.navigator,
  });
  Object.defineProperty(globalThis, "Element", {
    configurable: true,
    writable: true,
    value: window.Element,
  });
  Object.defineProperty(globalThis, "HTMLElement", {
    configurable: true,
    writable: true,
    value: window.HTMLElement,
  });
  Object.defineProperty(globalThis, "EventSource", {
    configurable: true,
    writable: true,
    value: MockEventSource,
  });
  Object.defineProperty(window, "EventSource", {
    configurable: true,
    writable: true,
    value: MockEventSource,
  });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    writable: true,
    value: true,
  });

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
}

function restoreDom(): void {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: previousWindow,
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    writable: true,
    value: previousDocument,
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    writable: true,
    value: previousNavigator,
  });
  Object.defineProperty(globalThis, "Element", {
    configurable: true,
    writable: true,
    value: previousElement,
  });
  Object.defineProperty(globalThis, "HTMLElement", {
    configurable: true,
    writable: true,
    value: previousHTMLElement,
  });
  Object.defineProperty(globalThis, "EventSource", {
    configurable: true,
    writable: true,
    value: previousEventSource,
  });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    writable: true,
    value: previousActEnvironment,
  });
}

function runFixture(runId: string, status = "running") {
  return {
    runId,
    status,
    passed: null,
    exitCode: null,
    preset: null,
    label: null,
    trigger: "server",
    cancelledAt: null,
    presetId: null,
    startedAt: "2026-04-17T00:00:00.000Z",
    completedAt: status === "running" ? null : "2026-04-17T00:01:00.000Z",
    suiteFingerprint: null,
    aggregateCounts: {
      scenarioTotal: 1,
      scenarioPassedCount: 0,
      scenarioFailedCount: 0,
      scenarioErroredCount: 0,
    },
    scenarios: [
      {
        ordinal: 0,
        scenarioId: `${runId}-scenario`,
        scenarioName: `Scenario for ${runId}`,
        status: "running",
        passed: null,
        failureKind: null,
        overallScore: null,
        passThreshold: null,
        turns: [],
        toolCalls: [],
        checkpoints: [],
        judgeDimensionScores: [],
        startedAt: "2026-04-17T00:00:00.000Z",
        completedAt: null,
      },
    ],
  };
}

async function flushReact(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  MockEventSource.instances = [];
  installDom();
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root?.unmount();
      await flushReact();
    });
  }
  root = undefined;
  restoreDom();
});

describe("RunDetailView SSE subscription", () => {
  test("keeps one EventSource for repeated run updates", async () => {
    const requestPaths: string[] = [];
    const request = async (path: string) => {
      requestPaths.push(path);
      return { run: runFixture("run-a") };
    };

    await act(async () => {
      root?.render(
        React.createElement(RunDetailView, {
          runId: "run-a",
          request,
          token: "token-a",
        }),
      );
      await flushReact();
    });

    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0]?.url).toBe(
      "/api/runs/run-a/events?access_token=token-a",
    );

    for (let i = 0; i < 5; i += 1) {
      await act(async () => {
        MockEventSource.instances[0]?.emit("scenario_finished");
        await flushReact();
      });
    }

    expect(requestPaths).toHaveLength(6);
    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0]?.closed).toBe(false);
  });

  test("closes the previous EventSource and ignores stale run loads when runId changes", async () => {
    const pending: PendingRequest[] = [];
    const request = (path: string) =>
      new Promise((resolve, reject) => {
        pending.push({ path, resolve, reject });
      });

    await act(async () => {
      root?.render(
        React.createElement(RunDetailView, {
          runId: "run-a",
          request,
          token: "",
        }),
      );
      await flushReact();
    });

    expect(pending[0]?.path).toBe("/api/runs/run-a");
    expect(MockEventSource.instances).toHaveLength(1);

    await act(async () => {
      root?.render(
        React.createElement(RunDetailView, {
          runId: "run-b",
          request,
          token: "",
        }),
      );
      await flushReact();
    });

    expect(pending[1]?.path).toBe("/api/runs/run-b");
    expect(MockEventSource.instances).toHaveLength(2);
    expect(MockEventSource.instances[0]?.closed).toBe(true);
    expect(MockEventSource.instances[1]?.url).toBe("/api/runs/run-b/events");

    await act(async () => {
      pending[0]?.resolve({ run: runFixture("run-a") });
      await flushReact();
    });
    expect(container.textContent).not.toContain("run-a");

    await act(async () => {
      pending[1]?.resolve({ run: runFixture("run-b") });
      await flushReact();
    });

    expect(container.textContent).toContain("run-b");
    expect(container.textContent).not.toContain("run-a");
    expect(MockEventSource.instances).toHaveLength(2);
  });
});

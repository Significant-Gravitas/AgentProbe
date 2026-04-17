import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { CompareView } from "../../../dashboard/src/components/CompareView.tsx";

const RUN_A = "11111111111111111111111111111111";
const RUN_B = "22222222222222222222222222222222";

type FetchResponder = (url: string) => Response | Promise<Response>;

let browser: Window;
let container: HTMLElement;
let root: Root | undefined;
const originalGlobals = {
  window: globalThis.window,
  document: globalThis.document,
  navigator: globalThis.navigator,
  HTMLElement: globalThis.HTMLElement,
  fetch: globalThis.fetch,
  IS_REACT_ACT_ENVIRONMENT: (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function installBrowser(url: string): void {
  browser = new Window({ url });
  (browser as unknown as { SyntaxError: SyntaxErrorConstructor }).SyntaxError =
    SyntaxError;
  container = browser.document.createElement("div");
  browser.document.body.append(container);

  Object.defineProperty(globalThis, "window", {
    value: browser,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "document", {
    value: browser.document,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "navigator", {
    value: browser.navigator,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "HTMLElement", {
    value: browser.HTMLElement,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    value: true,
    configurable: true,
    writable: true,
  });
}

function installFetch(responder: FetchResponder): void {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url =
      input instanceof Request ? input.url : input instanceof URL ? input.href : input;
    return Promise.resolve(responder(String(url)));
  }) as typeof fetch;
}

async function renderCompare(
  url: string,
  responder: FetchResponder,
): Promise<void> {
  installBrowser(url);
  installFetch(responder);
  await act(async () => {
    root = createRoot(container);
    root.render(<CompareView token={null} />);
  });
  await flushAsync();
}

async function flushAsync(): Promise<void> {
  await act(async () => {
    await browser.happyDOM.whenAsyncComplete();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
  });
  await flushAsync();
}

function bodyText(): string {
  return container.textContent ?? "";
}

function buttonByText(text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (!(button instanceof browser.HTMLButtonElement)) {
    throw new Error(`Button not found: ${text}`);
  }
  return button;
}

function comparisonPayload(scenarios: unknown[]) {
  return {
    alignment: "scenario_id",
    runs: [
      {
        run_id: RUN_A,
        status: "completed",
        passed: true,
        label: "Baseline",
        preset_id: null,
        preset_snapshot_fingerprint: null,
        started_at: "2026-04-17T10:00:00.000Z",
        completed_at: "2026-04-17T10:01:00.000Z",
        scenario_total: 2,
        scenario_passed_count: 1,
        scenario_failed_count: 1,
        scenario_harness_failed_count: 0,
        scenario_errored_count: 0,
      },
      {
        run_id: RUN_B,
        status: "completed",
        passed: true,
        label: "Candidate",
        preset_id: null,
        preset_snapshot_fingerprint: null,
        started_at: "2026-04-17T11:00:00.000Z",
        completed_at: "2026-04-17T11:01:00.000Z",
        scenario_total: 2,
        scenario_passed_count: 2,
        scenario_failed_count: 0,
        scenario_harness_failed_count: 0,
        scenario_errored_count: 0,
      },
    ],
    scenarios,
    summary: {
      total_scenarios: scenarios.length,
      scenarios_changed: scenarios.length,
      scenarios_regressed: 0,
      scenarios_improved: scenarios.length,
      scenarios_missing_in_some: 0,
      average_score_delta: null,
    },
  };
}

beforeEach(() => {
  root = undefined;
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root?.unmount();
    });
  }
  browser?.close();
  Object.defineProperty(globalThis, "window", {
    value: originalGlobals.window,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "document", {
    value: originalGlobals.document,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "navigator", {
    value: originalGlobals.navigator,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "HTMLElement", {
    value: originalGlobals.HTMLElement,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    value: originalGlobals.IS_REACT_ACT_ENVIRONMENT,
    configurable: true,
    writable: true,
  });
  globalThis.fetch = originalGlobals.fetch;
});

describe("CompareView", () => {
  test("filters unchanged rows when only changes is enabled and formats null versus zero scores", async () => {
    await renderCompare(
      `http://localhost/compare?run_ids=${RUN_A},${RUN_B}`,
      (url) => {
        if (url.includes("/api/runs")) {
          return jsonResponse({ runs: [] });
        }
        if (url.includes("/api/comparisons")) {
          return jsonResponse(
            comparisonPayload([
              {
                alignment_key: "null-to-zero",
                file: null,
                scenario_id: "null-to-zero",
                scenario_name: "Null To Zero",
                present_in: [RUN_A, RUN_B],
                entries: {
                  [RUN_A]: {
                    run_id: RUN_A,
                    status: "fail",
                    score: null,
                    reason: null,
                  },
                  [RUN_B]: {
                    run_id: RUN_B,
                    status: "pass",
                    score: 0,
                    reason: null,
                  },
                },
                delta_score: null,
                status_change: "improved",
              },
              {
                alignment_key: "zero-score",
                file: null,
                scenario_id: "zero-score",
                scenario_name: "Zero Score",
                present_in: [RUN_A, RUN_B],
                entries: {
                  [RUN_A]: {
                    run_id: RUN_A,
                    status: "pass",
                    score: 0,
                    reason: null,
                  },
                  [RUN_B]: {
                    run_id: RUN_B,
                    status: "pass",
                    score: 0,
                    reason: null,
                  },
                },
                delta_score: 0,
                status_change: "unchanged",
              },
            ]),
          );
        }
        throw new Error(`Unexpected fetch: ${url}`);
      },
    );

    expect(bodyText()).toContain("Null To Zero");
    expect(bodyText()).toContain("Zero Score");
    const scores = Array.from(container.querySelectorAll(".compare-score")).map(
      (node) => node.textContent?.trim(),
    );
    expect(scores).toContain("—");
    expect(scores).toContain("0.00");

    const onlyChanges = container.querySelector(
      ".compare-actions input[type='checkbox']",
    );
    if (!(onlyChanges instanceof browser.HTMLInputElement)) {
      throw new Error("Only changes checkbox not found.");
    }
    await click(onlyChanges);

    expect(bodyText()).toContain("Null To Zero");
    expect(bodyText()).not.toContain("Zero Score");
  });

  test("disables Apply until the picker has a valid run count", async () => {
    await renderCompare("http://localhost/compare", (url) => {
      if (url.includes("/api/runs")) {
        return jsonResponse({
          runs: [
            {
              runId: RUN_A,
              status: "completed",
              label: "Baseline",
              startedAt: "2026-04-17T10:00:00.000Z",
            },
            {
              runId: RUN_B,
              status: "completed",
              label: "Candidate",
              startedAt: "2026-04-17T11:00:00.000Z",
            },
          ],
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    expect(buttonByText("Apply").disabled).toBe(true);

    const first = container.querySelector(`input[value='${RUN_A}']`);
    const second = container.querySelector(`input[value='${RUN_B}']`);
    if (
      !(first instanceof browser.HTMLInputElement) ||
      !(second instanceof browser.HTMLInputElement)
    ) {
      throw new Error("Run picker checkboxes not found.");
    }

    await click(first);
    expect(buttonByText("Apply").disabled).toBe(true);

    await click(second);
    expect(buttonByText("Apply").disabled).toBe(false);
  });

  test("renders an empty state when no aligned rows are returned", async () => {
    await renderCompare(
      `http://localhost/compare?run_ids=${RUN_A},${RUN_B}`,
      (url) => {
        if (url.includes("/api/runs")) {
          return jsonResponse({ runs: [] });
        }
        if (url.includes("/api/comparisons")) {
          return jsonResponse(comparisonPayload([]));
        }
        throw new Error(`Unexpected fetch: ${url}`);
      },
    );

    expect(bodyText()).toContain("No aligned scenario rows match this comparison.");
  });
});

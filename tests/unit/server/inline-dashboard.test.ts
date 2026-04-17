import { afterEach, describe, expect, test } from "bun:test";

import { dashboardHtml } from "../../../src/runtime/server/dashboard/inline.ts";

type FakeElement = {
  innerHTML: string;
  textContent: string;
  style: Record<string, string>;
  addEventListener: () => void;
  getAttribute: (name: string) => string | null;
  classList: {
    toggle: () => void;
  };
};

type BrowserGlobal = typeof globalThis & {
  document?: unknown;
  window?: unknown;
};

const browserGlobal = globalThis as BrowserGlobal;

const originalGlobals = {
  document: browserGlobal.document,
  fetch: globalThis.fetch,
  window: browserGlobal.window,
};

function createElement(): FakeElement {
  return {
    innerHTML: "",
    textContent: "",
    style: {},
    addEventListener: () => undefined,
    getAttribute: () => null,
    classList: {
      toggle: () => undefined,
    },
  };
}

function extractInlineScript(html: string): string {
  const match = html.match(/<script>([\s\S]*)<\/script>/);
  if (!match?.[1]) {
    throw new Error("Expected inline dashboard script.");
  }
  return match[1];
}

describe("inline dashboard", () => {
  afterEach(() => {
    Object.assign(globalThis, originalGlobals);
  });

  test("escapes scenario ordinals before rendering run-detail links", async () => {
    const content = createElement();
    const errorBox = createElement();
    const navLinks = ["/", "/runs", "/suites", "/settings"].map((href) => ({
      ...createElement(),
      getAttribute: (name: string) => (name === "href" ? href : null),
    }));
    const storage = new Map<string, string>();

    Object.assign(globalThis, {
      document: {
        getElementById: (id: string) => {
          if (id === "content") return content;
          if (id === "error") return errorBox;
          return createElement();
        },
        querySelectorAll: () => navLinks,
        addEventListener: () => undefined,
      },
      fetch: async (input: Parameters<typeof fetch>[0]) => {
        expect(String(input)).toBe("/api/runs/run-1");
        return new Response(
          JSON.stringify({
            run: {
              runId: "run-1",
              status: "completed",
              passed: true,
              startedAt: "2026-04-10T10:00:00Z",
              scenarios: [
                {
                  ordinal: '1" onclick="alert(1)',
                  scenarioId: "scenario-1",
                  status: "completed",
                  passed: true,
                  overallScore: 0.8,
                },
              ],
            },
          }),
        );
      },
      window: {
        localStorage: {
          getItem: (key: string) => storage.get(key) ?? null,
          removeItem: (key: string) => {
            storage.delete(key);
          },
          setItem: (key: string, value: string) => {
            storage.set(key, value);
          },
        },
        location: { pathname: "/runs/run-1" },
        history: { pushState: () => undefined },
        addEventListener: () => undefined,
      },
    });

    const script = extractInlineScript(dashboardHtml({ hasToken: false }));
    new Function(script)();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(content.innerHTML).toContain(
      'href="/runs/run-1/scenarios/1&quot; onclick=&quot;alert(1)">',
    );
    expect(content.innerHTML).toContain(">1&quot; onclick=&quot;alert(1)</a>");
    expect(content.innerHTML).not.toContain(
      'href="/runs/run-1/scenarios/1" onclick="alert(1)"',
    );
  });
});

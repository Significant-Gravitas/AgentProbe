import { beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";

const dashboardWindow = new Window({ url: "http://localhost/" });
const dashboardDocument = dashboardWindow.document;
(globalThis as Record<string, unknown>).window = dashboardWindow;
(globalThis as Record<string, unknown>).document = dashboardDocument;
(globalThis as Record<string, unknown>).KeyboardEvent = dashboardWindow.KeyboardEvent;
(globalThis as Record<string, unknown>).Element = dashboardWindow.Element;
(globalThis as Record<string, unknown>).HTMLElement = dashboardWindow.HTMLElement;

import {
  createKeyboardDispatcher,
  shouldIgnoreKeyboardEvent,
} from "../../../dashboard/src/hooks/useKeyboardShortcuts.ts";

describe("keyboard shortcut dispatcher", () => {
  beforeEach(() => {
    dashboardDocument.body.innerHTML = "";
  });

  function dispatch(
    handler: (event: KeyboardEvent) => void,
    key: string,
    target?: EventTarget,
  ): KeyboardEvent {
    const event = new dashboardWindow.KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
    }) as unknown as KeyboardEvent;
    if (target) {
      Object.defineProperty(event, "target", { value: target });
    }
    handler(event);
    return event;
  }

  test("ignores keys dispatched from text inputs", () => {
    const input = dashboardDocument.createElement("input");
    input.type = "text";
    dashboardDocument.body.appendChild(input);
    expect(shouldIgnoreKeyboardEvent(input)).toBeTrue();

    let calls = 0;
    const handler = createKeyboardDispatcher({
      shortcuts: [
        {
          key: "j",
          description: "down",
          run: () => {
            calls += 1;
          },
        },
      ],
    });
    dispatch(handler, "j", input);
    expect(calls).toBe(0);
  });

  test("fires single-key shortcut and calls preventDefault", () => {
    let calls = 0;
    const handler = createKeyboardDispatcher({
      shortcuts: [
        {
          key: "/",
          description: "focus",
          run: () => {
            calls += 1;
          },
        },
      ],
    });
    const event = dispatch(handler, "/");
    expect(calls).toBe(1);
    expect(event.defaultPrevented).toBeTrue();
  });

  test("fires g r sequence only after both keys", () => {
    let navigated = 0;
    const handler = createKeyboardDispatcher({
      shortcuts: [
        {
          sequence: ["g", "r"],
          key: "r",
          description: "go runs",
          run: () => {
            navigated += 1;
          },
        },
      ],
    });
    dispatch(handler, "g");
    expect(navigated).toBe(0);
    dispatch(handler, "r");
    expect(navigated).toBe(1);
  });

  test("resets pending sequence after timeout", () => {
    let navigated = 0;
    const handler = createKeyboardDispatcher({
      shortcuts: [
        {
          sequence: ["g", "r"],
          key: "r",
          description: "go runs",
          run: () => {
            navigated += 1;
          },
        },
      ],
      sequenceTimeoutMs: 1,
    });
    dispatch(handler, "g");
    const now = Date.now();
    while (Date.now() - now < 5) {
      // Spin the event loop past the tiny timeout.
    }
    dispatch(handler, "r");
    expect(navigated).toBe(0);
  });

  test("ignores when a modifier key is held", () => {
    let calls = 0;
    const handler = createKeyboardDispatcher({
      shortcuts: [
        {
          key: "j",
          description: "down",
          run: () => {
            calls += 1;
          },
        },
      ],
    });
    const event = new dashboardWindow.KeyboardEvent("keydown", {
      key: "j",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    }) as unknown as KeyboardEvent;
    handler(event);
    expect(calls).toBe(0);
    expect(event.defaultPrevented).toBeFalse();
  });
});

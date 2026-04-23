import { useEffect, useRef } from "react";

export type KeyboardShortcut = {
  key: string;
  sequence?: string[];
  description: string;
  run: (event: KeyboardEvent) => void;
};

export type KeyboardShortcutHandlerOptions = {
  shortcuts: KeyboardShortcut[];
  isEnabled?: () => boolean;
  sequenceTimeoutMs?: number;
};

const DEFAULT_SEQUENCE_TIMEOUT_MS = 800;

export function shouldIgnoreKeyboardEvent(target: EventTarget | null): boolean {
  if (!target || !(target instanceof Element)) {
    return false;
  }
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
    return true;
  }
  if (tag === "BUTTON") {
    return false;
  }
  const htmlEl = target as HTMLElement;
  if (htmlEl.isContentEditable) {
    return true;
  }
  return false;
}

export function createKeyboardDispatcher(
  options: KeyboardShortcutHandlerOptions,
): (event: KeyboardEvent) => void {
  const { shortcuts, isEnabled } = options;
  const timeoutMs = options.sequenceTimeoutMs ?? DEFAULT_SEQUENCE_TIMEOUT_MS;
  const state = { pending: [] as string[], lastAt: 0 };

  return (event: KeyboardEvent) => {
    if (event.defaultPrevented) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (isEnabled && !isEnabled()) return;
    if (shouldIgnoreKeyboardEvent(event.target)) return;

    const now = Date.now();
    if (now - state.lastAt > timeoutMs) {
      state.pending = [];
    }
    state.lastAt = now;

    const currentKey = event.key;
    const nextSequence = [...state.pending, currentKey];

    const sequenceMatch = shortcuts.find(
      (shortcut) =>
        shortcut.sequence !== undefined &&
        shortcut.sequence.length === nextSequence.length &&
        shortcut.sequence.every((key, idx) => key === nextSequence[idx]),
    );
    if (sequenceMatch) {
      state.pending = [];
      event.preventDefault();
      sequenceMatch.run(event);
      return;
    }

    const hasSequencePrefix = shortcuts.some(
      (shortcut) =>
        shortcut.sequence !== undefined &&
        shortcut.sequence.length > nextSequence.length &&
        shortcut.sequence
          .slice(0, nextSequence.length)
          .every((key, idx) => key === nextSequence[idx]),
    );

    if (hasSequencePrefix) {
      state.pending = nextSequence;
      event.preventDefault();
      return;
    }

    const singleMatch = shortcuts.find(
      (shortcut) =>
        shortcut.sequence === undefined && shortcut.key === currentKey,
    );
    if (singleMatch) {
      state.pending = [];
      event.preventDefault();
      singleMatch.run(event);
      return;
    }

    state.pending = [];
  };
}

export function useKeyboardShortcuts(
  options: KeyboardShortcutHandlerOptions,
): void {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  useEffect(() => {
    const dispatcherRef: { current: (event: KeyboardEvent) => void } = {
      current: createKeyboardDispatcher(optionsRef.current),
    };
    let previousShortcuts = optionsRef.current.shortcuts;
    const handler = (event: KeyboardEvent): void => {
      if (previousShortcuts !== optionsRef.current.shortcuts) {
        dispatcherRef.current = createKeyboardDispatcher(optionsRef.current);
        previousShortcuts = optionsRef.current.shortcuts;
      }
      dispatcherRef.current(event);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
}

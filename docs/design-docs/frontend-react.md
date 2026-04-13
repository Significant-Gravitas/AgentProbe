# Frontend React Design Guide

Durable principles for writing React applications in this repository.
These rules apply to the `dashboard/` app and any future React surfaces.

## Tech baseline

- React 19, Vite, TypeScript
- No state management library unless proven necessary
- Profiler-driven optimization, not guesswork

---

## 1. Understand what actually triggers re-renders

React has exactly three re-render triggers:

1. **A component's own state changes** (`useState`, `useReducer`)
2. **A parent component re-renders** (children re-render unconditionally)
3. **A consumed context value changes** (`useContext`)

**Props are not a trigger.** Props are inputs to a render that is already
happening. When a parent re-renders, React calls every child component
function regardless of whether props changed. This is normal, expected, and
fast.

```tsx
// Child re-renders every time Parent re-renders,
// even though `count` is always 5.
const Child = ({ count }: { count: number }) => {
  console.log("Child rendered");
  return <div>Count: {count}</div>;
};

const Parent = () => {
  const [parentCount, setParentCount] = useState(0);
  const childCount = 5; // never changes

  return (
    <>
      <button onClick={() => setParentCount((c) => c + 1)}>
        Clicked {parentCount} times
      </button>
      <Child count={childCount} />
    </>
  );
};
```

If you expected Child to skip rendering because its props didn't change,
your mental model is wrong. Fix the model before reaching for `React.memo`.

### Render vs. commit

A **render** means React called your component function and diffed the
output. A **commit** is when React actually touches the DOM. Many renders
result in zero DOM changes. Renders are cheap; unnecessary commits are what
hurt.

---

## 2. Keep state close to where it's used

The single most effective performance technique in React is **not lifting
state higher than it needs to be**. Every state change re-renders the
component that owns it and all descendants. Keep the blast radius small.

```tsx
// Bad: search state lives too high, every child re-renders on keystroke
const Dashboard = () => {
  const [search, setSearch] = useState("");
  return (
    <>
      <SearchBar value={search} onChange={setSearch} />
      <DataTable data={data} />
      <Charts data={data} />
    </>
  );
};

// Good: search state is local, siblings are unaffected
const Dashboard = () => {
  const [data, setData] = useState([]);
  return (
    <>
      <SearchSection />
      <DataTable data={data} />
      <Charts data={data} />
    </>
  );
};

const SearchSection = () => {
  const [search, setSearch] = useState("");
  return <SearchBar value={search} onChange={setSearch} />;
};
```

When `search` changes, only `SearchSection` re-renders. `DataTable` and
`Charts` don't even know it happened. No memo required.

This is **composition** — React's primary performance tool since day one.

---

## 3. Separate render from behavior

When a component has non-trivial logic (data fetching, state machines,
complex event handling), split it into two files: a hook that owns the
behavior and a component that owns the JSX.

```
FeatureX/
  FeatureX.tsx        (render logic only)
  useFeatureX.ts      (hook: data fetching, state, side effects)
  helpers.ts          (pure functions used by the hook)
  components/         (sub-components local to FeatureX)
```

The hook returns a plain object that the component destructures:

```tsx
// useStatsPanel.ts
export function useStatsPanel() {
  const [stats, setStats] = useState<Stats[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    fetchStats().then(setStats).finally(() => setIsLoading(false));
  }, []);

  return { stats, isLoading, refresh: () => fetchStats().then(setStats) };
}

// StatsPanel.tsx
export function StatsPanel() {
  const { stats, isLoading, refresh } = useStatsPanel();
  if (isLoading) return <Skeleton />;
  return <div>...</div>;
}
```

This separation has direct performance benefits:

- **State stays colocated.** The hook lives next to the component that
  consumes its state, so re-renders don't propagate up.
- **Composition becomes natural.** When a component gets big, you extract a
  sub-component with its own hook. Each sub-tree re-renders independently.
- **Testing is simpler.** You can test the hook's logic without rendering
  anything, and test the component's output with stubbed hook data.

When to skip the split: if the hook would be 3-4 lines (a single
`useState`, a toggle), keep it inline in the component file.

---

## 4. Don't abuse useEffect

`useEffect` is for synchronizing with external systems (APIs, timers,
subscriptions, DOM measurements). It is not for deriving state from other
state.

```tsx
// Bad: syncing derived state through useEffect
const [items, setItems] = useState<Item[]>([]);
const [filteredItems, setFilteredItems] = useState<Item[]>([]);
const [search, setSearch] = useState("");

useEffect(() => {
  setFilteredItems(items.filter((i) => i.name.includes(search)));
}, [items, search]);

// Good: derive during render
const [items, setItems] = useState<Item[]>([]);
const [search, setSearch] = useState("");

const filteredItems = items.filter((i) => i.name.includes(search));
```

The `useEffect` version is worse in every way: it causes an extra
re-render (state update inside an effect), it's harder to follow, and it
introduces a frame where `filteredItems` is stale.

**Rules of thumb:**

- If you can compute it from existing state/props during render, do that.
  No `useEffect`, no `useMemo` (unless profiler says otherwise).
- If you're setting state inside a `useEffect` that depends on other
  state, you almost certainly have a derived-state problem. Remove the
  effect and compute the value inline.
- Reserve `useEffect` for genuine side effects: fetching data, starting
  subscriptions, measuring DOM elements, integrating with non-React code.

---

## 5. Complex cross-component state

State colocation (section 2) is the default. When multiple distant
components genuinely need to read and write the same state — multi-step
wizards, builder UIs, coordinated panels — use a colocated store with
**typed selectors** to keep the re-render blast radius small.

```ts
// FeatureX/store.ts
import { create } from "zustand";

interface WizardState {
  step: number;
  data: Record<string, unknown>;
  next(): void;
  back(): void;
  setField(key: string, value: unknown): void;
}

export const useWizardStore = create<WizardState>((set) => ({
  step: 0,
  data: {},
  next: () => set((s) => ({ step: s.step + 1 })),
  back: () => set((s) => ({ step: Math.max(0, s.step - 1) })),
  setField: (key, value) =>
    set((s) => ({ data: { ...s.data, [key]: value } })),
}));
```

Consume via selectors — each component subscribes to only the slice it
needs, so it only re-renders when that slice changes:

```tsx
function WizardFooter() {
  const step = useWizardStore((s) => s.step);
  const next = useWizardStore((s) => s.next);
  const back = useWizardStore((s) => s.back);
  // Only re-renders when `step`, `next`, or `back` change
  return (
    <div>
      <button onClick={back} disabled={step === 0}>Back</button>
      <button onClick={next}>Next</button>
    </div>
  );
}
```

**Guidelines:**

- Colocate the store with the feature (`FeatureX/store.ts`), not in a
  global `stores/` directory.
- Stores hold state and pure actions. Keep effects and API calls in hooks.
- If only 2-3 components share state and they're in the same subtree,
  prefer lifting state to a common parent over introducing a store.

---

## 6. Memoization: measure first, optimize second

### The memoization trap

Developers see slowness, assume it's re-renders, blanket the codebase with
`React.memo` / `useMemo` / `useCallback`, and ship. The app stays slow
because the real bottleneck was something else entirely:

- API calls firing on every keystroke (add a debounce)
- Unoptimized images (compress or lazy-load them)
- Too many DOM nodes (virtualize long lists)
- CSS animations triggering layout recalculation
- Expensive synchronous work blocking the main thread

**Workflow:** Open React DevTools Profiler, reproduce the slow interaction,
read the flame graph. If no component exceeds ~16 ms, re-renders are not
your problem.

### When memoization is justified

| Situation | Tool | Why |
|---|---|---|
| Component renders 50 ms+ with unchanged props and re-renders often | `React.memo` | Skips calling the component function when props are shallow-equal |
| Genuinely expensive derived data (thousands of items, complex transforms) | `useMemo` | Caches the computation across renders |
| Stabilizing a callback passed to an already-memoized child | `useCallback` | Prevents breaking the child's memo check |
| Context provider value is a new object reference every render | `useMemo` on the value | Prevents all consumers from re-rendering |

### When memoization is not justified

- A component renders 3 divs. The memo check costs more than the render.
- `.filter()` on 200 items. That's sub-millisecond work.
- "Just in case" — you're adding complexity without evidence.
- `useCallback` on a handler that isn't passed to a memoized child. It
  does nothing useful.

### The memo/useCallback chain

`useCallback` only matters when the callback is passed to a `React.memo`
child. Without memo on the child, stabilizing the reference is pointless.
Without `useCallback` on the handler, the memo on the child is defeated.
They are a pair — don't use one without the other.

```tsx
const MemoizedChild = React.memo(({ onClick }: { onClick: () => void }) => {
  return <button onClick={onClick}>Click</button>;
});

// Breaks memoization: new function every render
<MemoizedChild onClick={() => handleClick()} />;

// Works: stable reference
const handleClick = useCallback(() => doSomething(), []);
<MemoizedChild onClick={handleClick} />;
```

---

## 7. Context pitfalls

Every component that calls `useContext(SomeContext)` re-renders when the
context **value reference** changes. If the provider creates a new object
on every render, all consumers re-render — even if the object's contents
are identical.

```tsx
// Bad: new object reference every render
const App = () => {
  const [theme, setTheme] = useState("light");
  const value = { theme, setTheme }; // new ref each time

  return (
    <ThemeContext.Provider value={value}>
      <ExpensiveTree />
    </ThemeContext.Provider>
  );
};

// Good: stable reference when theme hasn't changed
const App = () => {
  const [theme, setTheme] = useState("light");
  const value = useMemo(() => ({ theme, setTheme }), [theme]);

  return (
    <ThemeContext.Provider value={value}>
      <ExpensiveTree />
    </ThemeContext.Provider>
  );
};
```

For contexts that carry both rarely-changing data and frequently-changing
data, split them into separate providers so consumers of the stable data
don't re-render when the volatile data changes.

---

## 8. Common real-world bottlenecks

Before blaming React, check these first:

| Symptom | Likely cause | Fix |
|---|---|---|
| Typing in a search box feels laggy | API/analytics call on every keystroke | Debounce the call (200-300 ms) |
| Page feels slow on mount | Large unoptimized images loading synchronously | Compress, lazy-load, use appropriate formats |
| Scrolling a long list janks | Too many DOM nodes | Virtualize with a windowing library |
| Interaction feels frozen for 100 ms+ | Synchronous heavy computation in render | Move to a web worker or break into chunks |
| Everything re-renders when theme toggles | Context value is an unstable reference | `useMemo` the provider value |

---

## 9. Rules for this codebase

### Performance

1. **No preemptive memoization.** Do not add `React.memo`, `useMemo`, or
   `useCallback` without a profiler measurement showing the need.
2. **State locality first.** Default to colocating state with the component
   that uses it. Lift only when a sibling genuinely needs the same value.
3. **Composition over optimization hooks.** Restructure the component tree
   before reaching for memoization. Moving state down or extracting a
   wrapper component is almost always simpler and more effective.
4. **Debounce external calls.** Any callback that triggers a network
   request or heavy computation on user input must be debounced or
   throttled. Never fire API calls on every keystroke.
5. **Profile before and after.** If you add an optimization, include the
   before/after profiler numbers in the PR description. If you can't
   measure the difference, revert the optimization.
6. **Trust React's reconciler.** Re-renders are cheap. The virtual DOM diff
   is fast. A 50-component tree re-rendering in under 10 ms is normal and
   not a problem. Optimize based on data, not fear.
7. **Lazy-load heavy assets.** Images, large data visualizations, and
   code-split routes should load on demand, not block initial render.

### Structure

8. **Separate render from behavior.** When a component has non-trivial
   logic, split into `Component.tsx` (JSX) and `useComponent.ts` (hook).
   Keep the hook as the single entry point for state, effects, and
   callbacks. Push pure computation into a sibling `helpers.ts`.
9. **No useEffect for derived state.** If a value can be computed from
   existing state or props during render, compute it inline. Do not
   synchronize it through a `useEffect` + `setState` cycle.
10. **Use selectors for shared stores.** When a Zustand (or similar) store
    is necessary, every consumer must subscribe via a selector for the
    specific slice it needs. Never `useStore()` without a selector — that
    re-renders on every store change.
11. **Colocate everything.** Sub-components, hooks, helpers, and stores
    live next to the feature that owns them. Only promote to a shared
    location (`src/components/`, `src/lib/`) when a second consumer exists.
12. **Prefer function declarations** for components and named handlers.
    Reserve arrow functions for short inline callbacks (`.map`, `.filter`).
13. **Use early returns** to flatten conditional render logic. Avoid deeply
    nested ternaries in JSX.

---

## Summary mental model

```
State changes  -->  Owner re-renders  -->  All children re-render
                                            (props don't matter)

Composition    -->  Keep state low, keep blast radius small
                    (the real performance tool)

Structure      -->  useX.ts owns behavior, X.tsx owns JSX
                    (derive values during render, not via useEffect)

Shared state   -->  Colocated store + typed selectors
                    (each consumer subscribes to its slice only)

React.memo     -->  Bails out early if props are shallow-equal
                    (useful only when proven necessary)
```

Write simple code. Separate render from behavior. Derive values inline.
Measure when something feels slow. Optimize what the profiler tells you
to. That's it.

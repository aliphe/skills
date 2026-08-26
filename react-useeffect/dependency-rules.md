# Dependency Rules for useEffect

Once you've decided an Effect *is* needed, these rules keep it correct. The core mental model: **every render captures its own props and state**. An Effect function "sees" the props and state from the render that created it — not the latest ones.

## 1. Effects See Values From Their Own Render

```tsx
function Counter() {
  const [count, setCount] = useState(0);

  useEffect(() => {
    setTimeout(() => {
      console.log(`You clicked ${count} times`); // Logs the count from THIS render
    }, 3000);
  }); // no deps: re-created every render

  // ...
}
```

Clicking 3 times quickly logs `0`, `1`, `2` — one snapshot per render, not three logs of `3`. This is intentional: within a single render, props and state are constants.

**Consequence**: if an Effect's closure uses a value from render scope, that value belongs to a specific render. The dependency array exists to tell React which renders matter.

---

## 2. Never Lie About Dependencies

If a value from render scope is used inside an Effect, it **must** be in the dependency array. Omitting it doesn't make React ignore the closure — it makes React skip re-running the Effect while the stale closure keeps using its old captured value.

```tsx
// BAD: [] claims "uses nothing from render scope" — but it uses count
function Counter() {
  const [count, setCount] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      setCount(count + 1); // Always setCount(0 + 1): the first render's count
    }, 1000);
    return () => clearInterval(id);
  }, []); // Effect never re-runs, interval keeps setting count to 1
}

// WHY IT BREAKS: [] doesn't mean "run once on mount". It means "this Effect
// uses nothing from render scope". That claim is false here.
```

The fix is **not** to remove a dependency you're "tired of". Fix the Effect so it needs fewer dependencies (see below), or include them all and accept the resubscription.

---

## 3. Remove False Dependencies With Functional Updates

If you only read state to compute its next value, use the updater form — it sends React an *instruction* instead of a value, so the old state isn't part of the data flow anymore.

```tsx
// GOOD: no count dependency needed at all
useEffect(() => {
  const id = setInterval(() => {
    setCount(c => c + 1); // "increment whatever it is now"
  }, 1000);
  return () => clearInterval(id);
}, []);
```

This is honest: the Effect genuinely reads nothing from render scope.

---

## 4. useReducer When State Depends on State or Props

Functional updates hit their limit when next state depends on *another* state variable or a prop. Replace them with a reducer and dispatch an action encoding **what happened**, not the new value:

```tsx
function Counter({ step }) {
  const [count, dispatch] = useReducer(reducer, 0);

  function reducer(state, action) {
    if (action.type === 'tick') return state + step; // reducer can read props
    throw new Error();
  }

  useEffect(() => {
    const id = setInterval(() => {
      dispatch({ type: 'tick' });
    }, 1000);
    return () => clearInterval(id);
  }, [dispatch]); // dispatch is guaranteed stable — interval never resets
}
```

**Why it works**: React guarantees `dispatch` identity never changes, and reducers run during the *next render* where fresh props are in scope. The Effect stays decoupled from `step`.

---

## 5. Functions Used Only by an Effect → Move Them Inside

Functions defined in the component get a new identity every render. If an Effect calls one, either the deps array lies, or it re-triggers every render. Moving the function into the Effect makes the truth obvious:

```tsx
// GOOD: function lives inside the Effect
useEffect(() => {
  async function fetchData() {
    const result = await axios(getUrl());
    setData(result.data);
  }
  function getUrl() {
    return `/api/search?q=${query}`; // uses query? lint rule catches missing dep
  }
  fetchData();
}, [query]);
```

If you later edit the moved function to read more state, the exhaustive-deps lint rule flags the Effect right there — instead of silently going stale.

---

## 6. Shared Functions → Hoist or Memoize

If several Effects (or components) need the same function:

- **Doesn't use props/state?** Hoist it outside the component. It can't be affected by the data flow, so it needs no deps.
- **Uses props/state?** Wrap it in `useCallback` where it's defined:

```tsx
const getFetchUrl = useCallback(() => {
  return `/api/search?q=${query}`;
}, [query]); // stable identity until query changes

useEffect(() => {
  fetch(getFetchUrl()).then(setData);
}, [getFetchUrl]); // refetches only when query actually changed
```

`useCallback` makes functions participate in the data flow like any other value: inputs changed → function changed → Effects depending on it re-run. Same idea applies to function props received from a parent.

Don't reach for `useCallback` everywhere — prefer moving logic into custom hooks or keeping callbacks out of Effects entirely.

---

## 7. Cleanup Runs Before Every Re-Run — Not Just Unmount

Each render has its own cleanup, capturing its own render's values:

```tsx
useEffect(() => {
  const conn = createConnection(roomId); // this render's roomId
  conn.connect();
  return () => conn.disconnect(); // disconnects THIS render's room
}, [roomId]);
```

Sequence on `roomId` change: render with new value → browser paints → cleanup of the *old* Effect → setup of the *new* Effect. Cleanup is delayed until after paint, and it always undoes the exact thing its own setup did.

---

## 8. Escape Hatch: Reading the Latest Value via Ref

Sometimes an async callback genuinely must see the current value (e.g. a long-lived timer logging the latest count). Opt in explicitly with a ref:

```tsx
const latestCount = useRef(count);

useEffect(() => {
  latestCount.current = count;
  setTimeout(() => {
    console.log(latestCount.current); // whatever count is NOW
  }, 3000);
});
```

Unlike captured values, `latestCount.current` carries no guarantee about when you read it. That fragility is why this is opt-in rather than the default behavior.

---

## Summary

| Situation | Solution |
|-----------|----------|
| Value used in Effect | It goes in the dep array — no exceptions |
| Setting state from previous state | Functional updater: `setX(x => …)` |
| Next state depends on other state / props | `useReducer` + dispatch actions |
| Helper function used by one Effect | Define it inside the Effect |
| Helper used by multiple Effects, pure | Hoist outside the component |
| Helper shared / passed as prop, uses data | `useCallback` where defined |
| Truly need latest value in async callback | Mutable ref (deliberate opt-in) |

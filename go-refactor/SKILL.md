---
name: go-refactor
description: Protocol for safely refactoring Go code in the backend. Load this skill whenever gocyclo or gocognit flags a function you are about to change, or whenever a refactoring move is part of the current task (not a future todo). Covers the full Fowler cycle - pin existing behaviour with tests, apply a named move, verify coverage on the changed code.
---

<what-to-do>

## Step 1 — Identify the target

Name the exact function(s) you will structurally change. Be precise: if a package has 10 complex functions but you are only touching one, your scope is that one function. Do not expand scope to the whole file or package.

If the reason for refactoring is a lint flag, confirm which flag and which function triggered it:

```bash
cd backend
gocyclo -over 10 ./path/to/package/...
gocognit -over 15 ./path/to/package/...
```

## Step 2 — Pin the current behaviour (pre-refactor)

Before changing any production code, establish a safety net for the function(s) in scope.

### 2a. Measure current coverage

```bash
cd backend
go test -coverprofile=/tmp/cover.out ./path/to/package/...
go tool cover -func=/tmp/cover.out | grep "FunctionName"
```

### 2b. Identify uncovered branches

Look at the output. For each branch in the target function that is not covered, note what input would exercise it.

If coverage is already 100% for the target function, skip to Step 3.

### 2c. Write pinning tests

Write table-driven tests that cover the missing branches. Rules:
- Tests go in the `_test.go` file for the package, using the `package foo` (same-package) convention so unexported helpers are reachable.
- Use table-driven format: one `tests := []struct{...}` slice, one `for _, tc := range tests` loop.
- Each case must have a name that describes the scenario, not the input value.
- Use a `ptr[T]` generic helper to avoid `&v` verbosity when building pointer fields.
- Do not test proto-generated delegation wrappers, `String()`/`Error()` methods on error types, or nil-guard early returns that are structurally unreachable from any caller in the codebase. If you skip a branch for one of these reasons, state it explicitly in a comment.

Run tests to confirm they pass before continuing:

```bash
cd backend
go test ./path/to/package/...
```

## Step 3 — Apply the refactoring move

Choose the appropriate named move from the catalogue below. Apply one move at a time. Run tests after each move to confirm nothing broke.

```bash
cd backend
go test ./path/to/package/...
```

### Fowler move catalogue (Go-adapted)

**Extract Function**
Move a block of code into its own named function. Use when a block has a clear purpose that can be named, or when the same logic appears more than once. The extracted function takes all variables the block read as parameters and returns what it wrote.

**Inline Function**
The opposite of Extract Function. Use when a function's body is as clear as its name, or when indirection is adding noise without adding clarity.

**Extract Variable**
Assign a sub-expression to a named local variable. Use to give a name to a complex condition or intermediate value. Especially useful before further extraction.

**Inline Variable**
Replace a variable that is used exactly once and adds no clarity with its initialiser directly.

**Rename**
Rename a function, variable, parameter, or type so its name matches what it actually does. Apply whenever the current name is misleading or too generic. Rename first, then extract — never the reverse.

**Decompose Conditional**
Extract the condition of an `if` and each branch into named functions. Use when the condition logic is non-trivial or the branches are long enough to obscure the overall flow.

**Consolidate Conditional Expression**
When multiple `if` statements check different conditions but return the same result, combine them into one with `||` or `&&`. Add Extract Variable first if the combined condition is hard to read.

**Replace Temp with Query**
Replace a local variable that is computed once and only read (never reassigned) with a function call. Keeps the function shorter and makes the computation independently testable.

**Split Loop**
When a single loop does two independent things, split it into two loops. Clarity beats micro-optimisation; only recombine if profiling shows it matters.

**Replace Loop with Pipeline**
Replace a `for` loop that filters or transforms a slice with `lo.Filter`, `lo.Map`, or a similar pipeline from `samber/lo` (already a project dependency).

**Slide Statement**
Move a variable declaration or statement closer to where it is used. Reduces the mental distance between definition and use.

**Separate Query from Modifier**
If a function both computes a value and changes state, split it into a pure query function and a separate modifier. The query can then be tested without side effects.

**Replace Error Code with Sentinel / Value Error**
Replace ad-hoc `int` or `string` error codes with typed sentinel errors (`var ErrFoo = errors.New(...)`) or structured value errors. See the project's error handling conventions in `AGENTS.md`.

## Step 4 — Verify

### 4a. Coverage on the changed code

Re-run coverage and confirm every new or modified function reaches 100%, subject to the same exemptions as Step 2c.

```bash
cd backend
go test -coverprofile=/tmp/cover.out ./path/to/package/...
go tool cover -func=/tmp/cover.out | grep -E "FunctionName|helperName"
```

If new helpers were extracted, they must be covered individually — do not rely on integration paths through the caller to cover them.

### 4b. Lint confirmation

If the refactoring was triggered by a lint flag, confirm it is gone:

```bash
cd backend
gocyclo -over 10 ./path/to/package/...
gocognit -over 15 ./path/to/package/...
```

### 4c. Full package test

```bash
cd backend
go test ./path/to/package/...
```

</what-to-do>

<supporting-info>

## Why pin before you move

A refactoring move must not change observable behaviour. Tests written after the refactoring cannot distinguish between "the refactor was correct" and "we happened to test the new structure". Tests written before the refactoring prove that the structure change did not alter the outcome.

## Coverage target and exemptions

Aim for 100% on the functions in scope. You may leave a branch uncovered only for:

1. **Nil-guard early returns** that are structurally unreachable from any caller in the codebase (e.g. a nil receiver check on a method that is only called on guaranteed non-nil values). Verify this by grepping callers before exempting.
2. **Thin proto-delegation wrappers** — functions whose entire body is `return pb.GeneratedMethod(...)` with no branching.
3. **`String()`/`Error()` methods on error types** — these are display utilities, not logic.

When you exempt a branch, add a one-line comment above it explaining why, using present-tense language (not "this was unreachable when we refactored this").

## One move at a time

Running tests between each move is not optional. If a move breaks a test, you know exactly which move caused it. If you batch moves and tests break, you are debugging a diff, not a move.

## Scope discipline

The pin in Step 2 covers only the function(s) you will structurally change. If you notice other uncovered functions in the file, note them but do not pin them now. Adding unrelated tests to a refactoring PR makes the diff harder to review and conflates two concerns.

## Table-driven test conventions

```go
// ptr helper — define once per test file, avoids &v verbosity
func ptr[T any](v T) *T { return &v }

func TestFoo(t *testing.T) {
    tests := []struct {
        name  string
        input SomeType
        want  SomeOtherType
    }{
        {name: "descriptive scenario name", input: ..., want: ...},
    }
    for _, tc := range tests {
        t.Run(tc.name, func(t *testing.T) {
            got := Foo(tc.input)
            assert.Equal(t, tc.want, got)
        })
    }
}
```

Case names describe the scenario ("month below minimum with no total limit"), not the input value ("month=50, all=nil"). The name is what appears in failure output — it should explain what went wrong without reading the struct.

</supporting-info>

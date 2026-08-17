# TypeScript — typescript-language-server

Detection: `tsconfig.json` / `tsconfig.base.json` (or `package.json` with TypeScript sources) in the workspace root.
Server: `typescript-language-server` — resolved from the nearest `node_modules/.bin` walking up from the project, then PATH.
Install (in the project): `pnpm add -Dw typescript-language-server` plus **`typescript@^5`**.

> **Why ^5:** current `typescript-language-server` speaks to `tsserver`, which TypeScript 7 (the native compiler) no longer ships. With TS 7 installed the server fails with "Could not find a valid TypeScript installation." Pin `typescript@^5` until the toolchain catches up. (disco uses 5.9.3 — fine.)

## Operations

| You want | Action | LSP method | Notes |
|---|---|---|---|
| Safe rename (ident, class method, interface property, JSX tag) | `rename` | `prepareRename` + `rename` | Updates the **import** in every referencing file — the case a sed rename silently breaks. Respects type-only imports, camelCase/PascalCase, and JSX props. |
| Who uses this | `refs` | `textDocument/references` | Includes declaration + import/export statements. |
| Where is this defined | `def` | `textDocument/definition` | For a dependency, lands in `.d.ts` when no source is present. |
| Interface/type implementations | `impl` | `textDocument/implementation` | Classes implementing an interface, implementations of abstract methods. |
| Who calls this | `callers` | `prepareCallHierarchy` + `incomingCalls` | Direct callers only. |
| Outline of a file | `outline` | `textDocument/documentSymbol` | Hierarchical tree: interfaces, classes, methods, properties, nested types. |
| Symbol search across the project | `symbols QUERY` | `workspace/symbol` | Query is fuzzy; matches node_modules type names too — refine. |
| Type at a position | `hover` | `textDocument/hover` | |
| Organize imports / fix-all / source actions | `codeaction` | `textDocument/codeAction` | List at a position; `--apply N` for edit-bearing actions (organize-imports is a classic quickfix with an edit). |

## Gotchas

- The server resolves path aliases (`paths` in tsconfig); rename/refs work through them.
- `checkJs`/`allowJs` projects: JS files are only included if the tsconfig allows them — the runner opens `.ts/.tsx/.mts/.cts` sources by default; for mixed projects pass explicit `FILE:LINE:COL`.
- Rename is whole-project: it will edit `.d.ts` files (module declarations, global types) if the target is declared there — review those diffs.
- Big monorepos: the runner opens up to 2000 workspace sources before mutating ops; raise `--timeout` if the server is slow to answer.
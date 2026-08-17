# C/C++ — clangd

Detection: `compile_commands.json`, `CMakeLists.txt`, or `.c/.cc/.cpp/.h` sources in the workspace root.
Server: `clangd` (autodetected from PATH; ships with Xcode CLT / LLVM).
Note: clangd is the least magic of the three — its precision depends on a compilation database.

## Operations

| You want | Action | LSP method | Notes |
|---|---|---|---|
| Safe rename (ident, method, member) | `rename` | `prepareRename` + `rename` | Cross-translation-unit when a compile database exists; otherwise same-TU plus heuristics. |
| Who uses this | `refs` | `textDocument/references` | |
| Where is this declared | `def` | `textDocument/definition` | Land in the header for out-of-line members. |
| Type at a position | `hover` | `textDocument/hover` | |
| Outline of a file | `outline` | `textDocument/documentSymbol` | |
| Refactorings | `codeaction` | `textDocument/codeAction` | clangd exposes some (e.g. extract) — availability varies by build config; check `caps`. |

## Gotchas

- **Compilation database first.** Without `compile_commands.json` (or `compile_flags.txt`), clangd falls back to heuristics: `#include`s resolve poorly and symbol data is incomplete. For projects without a database, prefer `refs`/`hover` over `rename` — unsound edits are more likely.
- Member renames need the class definition visible to the TU being edited; edits outside the workspace root are skipped with a warning.
- clangd's cold index (`--background-index`) builds on first call; give it `--timeout 120` on large codebases.
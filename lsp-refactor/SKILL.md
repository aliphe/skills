---
name: lsp-refactor
description: Perform precise, validated refactorings through a one-shot Language Server Protocol client — rename symbols, find references and callers, jump to definitions, implementations, and type definitions, outline files, search symbols workspace-wide, read hover/type info, and list or apply code actions. Supports Go (gopls), TypeScript (typescript-language-server), and C/C++ (clangd). Use whenever a change should follow symbol boundaries — renaming a function, field, variable, type, or method — instead of sed/grep/string surgery, and for "who uses this", "what implements this interface", "who calls this", "where is this defined", or "what code actions exist here". The language server validates the target (prepareRename), returns exact WorkspaceEdits across all files, and the runner shuts the server down after every operation — nothing stays resident.
---

# lsp-refactor

One-shot [LSP](https://microsoft.github.io/language-server-protocol/) operations through `lsp.mjs` (in this skill's directory). Every invocation spawns the language server, performs one operation, applies/prints the result, and shuts the server down. No idle server, no daemon, no lifecycle to manage.

Throughout this file, `$SKILL_DIR` means this skill's directory — the folder containing SKILL.md (e.g. `~/.pi/agent/skills/lsp-refactor` or `~/.agents/skills/lsp-refactor`). Resolve it to that absolute path before running. The runner is also available directly as an executable: `$SKILL_DIR/lsp.mjs` supports a shebang + `chmod +x`.

The point of using an LSP instead of text tools: the server knows symbol boundaries. A rename updates only the real occurrences (across every file, including imports), never comments, strings, or other scopes with the same name; a "who calls this" query returns actual call sites, not grep hits.

## Let's say you need to rename a symbol

If the task is "rename `X` to `Y`" (or find refs / callers / definitions / implementations), do NOT reach for bash text tools. Run:

```bash
node "$SKILL_DIR/lsp.mjs" rename X Y                # auto-locates X, validates, applies
node "$SKILL_DIR/lsp.mjs" rename X Y --dry-run      # preview the edits without writing
node "$SKILL_DIR/lsp.mjs" rename X Y src/foo.ts     # restrict search to one file
```

The script:

1. Detects the language from the project (`go.mod` / `tsconfig.json` / `package.json` / `compile_commands.json`), finds the right server binary.
2. Locates the symbol: scans the workspace for files containing the identifier, then asks the server `textDocument/prepareRename` at each candidate position — the server confirms each position is a renameable symbol and returns its exact range. Comments and strings fail this check automatically.
3. Sends `textDocument/rename` and receives a WorkspaceEdit covering **every affected file** (TS: includes the import in `use.ts`; Go: includes calls from other packages).
4. Applies edits only inside the workspace root, prints a line-by-line old/new diff per file, then a `git diff --stat` when in a repo.
5. Shuts the server down. Nothing remains running.

## Command reference

Run from the project root. Positions are 1-based (`FILE:LINE:COL`, or `FILE:LINE` = col 1). All actions accept `--root DIR`, `--file FILE`, `--timeout SEC`, `--server BIN`.

```bash
node "$SKILL_DIR/lsp.mjs" detect                          # language + server binary + version
node "$SKILL_DIR/lsp.mjs" caps                            # what THIS server advertises (--json for raw)
node "$SKILL_DIR/lsp.mjs" rename OLD NEW [FILE] [--dry-run]
node "$SKILL_DIR/lsp.mjs" refs NAME [FILE]                # all references incl. declaration
node "$SKILL_DIR/lsp.mjs" def NAME [FILE]                 # go to definition
node "$SKILL_DIR/lsp.mjs" impl NAME [FILE]                # implementations / type definitions (Go interfaces)
node "$SKILL_DIR/lsp.mjs" callers NAME [FILE]             # who calls this symbol
node "$SKILL_DIR/lsp.mjs" outline FILE                    # symbol tree of a file
node "$SKILL_DIR/lsp.mjs" symbols QUERY                   # workspace-wide symbol search (fuzzy)
node "$SKILL_DIR/lsp.mjs" hover NAME | FILE:LINE:COL      # type/declaration info
node "$SKILL_DIR/lsp.mjs" codeaction NAME|FILE:LINE:COL [--apply N]   # list refactorings, apply one
```

If NAME-based location fails or you know the exact spot, pass a position directly: `node "$SKILL_DIR/lsp.mjs" refs src/bank.ts:21:17`.

## Per-language details

Read the matching sheet before doing work in that language — each lists the server, install steps, the operation table with language-specific notes, and gotchas:

- `caps/go.md` — gopls (rename across packages, interface→implementation, extract/inline code actions, call hierarchy)
- `caps/typescript.md` — typescript-language-server (import-aware rename, JSX, .d.ts, organize-imports code action)
- `caps/cpp.md` — clangd (rename/refs/hover; code actions depend on a compile database)

The `caps` action prints the actual capabilities and command list the installed server declares — newer servers advertise more; check it when you don't see the operation you need listed in the sheet.

## Workflow & safety rules

1. `--dry-run` first when the edit count is surprising or the symbol name is a common word.
2. Review the printed diff; the `-`/`+` pair per line is the whole change.
3. Renames never touch comments/strings — if the diff shows one, report it (it means the position probe found the symbol there, which the server allowed, usually inside a doc comment on the declaration itself: still correct, but flag it).
4. After an applied rename, run the repo's typecheck/build (`pnpm -r typecheck`, `go build ./...`, …) before finishing — LSP edits are correct at rename time but the surrounding task may still need verification.
5. Edits outside the workspace root are skipped with a warning (they're usually generated or vendored files — check them separately).
6. The server only sees files it was told about: `rename` and `codeaction` auto-open every source file in the workspace (≤2000 files) so cross-file edits are complete. Tune with... nothing yet — if a giant monorepo is slow, pass `--timeout SEC` up.

## Server prerequisites

| Language | Server | Install |
|---|---|---|
| Go | `gopls` | `go install golang.org/x/tools/gopls@latest` (or Homebrew) |
| TypeScript | `typescript-language-server` in the project | `pnpm add -Dw typescript-language-server` + `typescript@^5` |
| C/C++ | `clangd` | package manager / Xcode CLT |

**TypeScript 7 caveat:** the native TS 7 compiler dropped `tsserver`, which `typescript-language-server` requires. Pin `typescript@^5` in the project for now (disco uses 5.9.3, fine). If the server errors "Could not find a valid TypeScript installation", that's the cause.

## Adding a language

The runner is generic (action ↔ LSP method). To support a new server: add an entry in `EXTS` + `detectLanguage()` + `resolveServer()` + `serverCommand()` in `lsp.mjs`, and write a `caps/<lang>.md` sheet from the server's `initialize` capabilities. That's it.

## When NOT to use this

- Editing prose, docs, configs, or any non-symbol text (use normal file edits).
- Broad sweeps that the LSP doesn't model (e.g. renaming a string value across files) — LSP won't do it, fall back to explicit text tools with review.
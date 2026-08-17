# Go — gopls

Detection: a `go.mod` file in the workspace root.
Server: `gopls` (autodetected from PATH, `$GOBIN`, `~/go/bin`).
Install: `go install golang.org/x/tools/gopls@latest` (v0.22+ seen in the wild; older versions advertise fewer providers).

## Operations

| You want | Action | LSP method | Notes |
|---|---|---|---|
| Safe rename (field/var/method/type/struct tag) | `rename` | `prepareRename` + `rename` | Computes references across **all packages**; never touches comments/strings. Renaming a field updates every composite literal and struct usage. |
| Who uses this | `refs` | `textDocument/references` | Includes the declaration; covers imports-only usage and dot-imports. |
| Where is this defined | `def` | `textDocument/definition` | |
| What implements this interface | `impl` | `textDocument/implementation` | gopls's party trick: point at an interface method (or the interface) and get the concrete types/methods that satisfy it. |
| Who calls this | `callers` | `prepareCallHierarchy` + `incomingCalls` | Walks up to the direct callers only (not transitive). |
| Outline of a file | `outline` | `textDocument/documentSymbol` | Full struct/method/field/interface tree, unexported included. |
| Symbol search across the repo | `symbols QUERY` | `workspace/symbol` | Query is fuzzy — matches stdlib/packages too; refine with a more specific name. |
| Type/declaration of an identifier | `hover` | `textDocument/hover` | Returns rich info incl. struct sizes/offsets for fields. |
| Extract function / extract variable / inline call / organize imports / add missing stubs | `codeaction` | `textDocument/codeAction` | Run at a position inside the target code; list with `codeaction`, apply an edit-bearing one with `--apply N`. Some refactorings (e.g. `gopls.change_signature`, assembly viewing) come back as server-side commands with no editable result — those can't run one-shot; the runner tells you. |

## Capability discovery

`node "$SKILL_DIR/lsp.mjs" caps` prints what the installed gopls advertises — including the full `executeCommandProvider.commands` list (`gopls.add_import`, `gopls.implement_interface`, `gopls.extract_to_new_file`, `gopls.apply_fix`, `gopls.modify_tags`, `gopls.split_package`, …). If a capability you need isn't in the sheet, `caps` tells you whether this version has it; the `--json` flag dumps the raw capability object.

## Gotchas

- Cold start: gopls loads the module graph on first call (a `go.mod` with many deps takes a few seconds). Subsequent calls reuse gopls's disk cache — that's why one-shot stays acceptable. Pass `--timeout 120` for big modules.
- Renames work package-wide even for targets in files you didn't open (the runner opens all workspace sources before a rename).
- Generated files (`// Code generated ... DO NOT EDIT.`) and `vendor/` are inside the workspace, so edits there are applied like any other — if the diff shows generated files, revert those hunks.
- Build-tagged files: gopls resolves the current build configuration; symbols hidden behind a different build tag may not appear in refs. For those, pass the exact `FILE:LINE:COL` of a visible occurrence.
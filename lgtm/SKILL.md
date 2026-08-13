---
name: lgtm
description: Open a structured diff review in the browser so the user can review AI-generated code changes, group them into changesets, leave comments, and submit structured JSON feedback to stdout.
user-invocable: true
---

# lgtm — Local Diff Review for AI-Generated Changes

You are launching lgtm so the user can review AI-generated code changes in a rich browser interface.

## What lgtm does

lgtm is a local diff viewer that:
1. Renders a unified diff in a browser with syntax highlighting, collapsible file sections, and dark/light themes
2. Supports grouping files into logical **changesets** via a YAML/JSON spec (first-match-wins glob matching)
3. Accepts line-level review comments via `POST /api/submit`
4. Outputs structured JSON (`ReviewResult`) to **stdout** on submit, then shuts down

## When to use this skill

Use lgtm when:
- You've generated code changes and the user needs to review them before they land
- You want structured, machine-parseable feedback from the review
- You need to group a large diff into logical sections for easier review

Do NOT use lgtm for:
- Small, single-file changes that don't need a browser UI (just show the diff inline)
- Non-diff content (it only renders unified diffs)

## Prerequisites

Check if lgtm is available:
```bash
which lgtm || npm list -g lgtm
```

If not installed:
```bash
npm install -g lgtm
```

If the user doesn't want a global install, use npx:
```bash
npx lgtm
```

## CLI reference

```
lgtm [refs...] --spec <path> [--port <n>] [--open]
```

| Argument/Option | Description |
|---|---|
| `[refs...]` | Git refs passed 1:1 to `git diff` (e.g. `HEAD~1..HEAD`, `main...feat`). Omit to diff working tree. |
| `--spec <path>` | **Required.** YAML or JSON spec file defining changesets. |
| `-p, --port <n>` | Port to listen on (default: random). |
| `--open` | Automatically open the browser when the server starts. |

## Signal behavior

- **Ctrl+C** prints `lgtm: cancelled` to stderr, writes feedback to `/tmp/lgtm-feedback.json`, and exits 0.
- **Submit** writes JSON to stdout, writes feedback, then the server closes.

## Execution flow (strict order)

1. `lgtm` runs `git diff [refs...]`. If the diff is empty or git errors, it exits with an error message and writes feedback.
2. Parses the spec file (YAML or JSON, detected by extension). Validates that `changesets` is a non-empty array. Exits with error if invalid.
3. Starts the Express server and prints the URL to stderr.
4. Optionally opens the browser if `--open`.
5. Blocks until the user submits (POST /api/submit).
6. Writes the review JSON to stdout, writes feedback to `/tmp/lgtm-feedback.json`, exits 0.

## Feedback file

Always written to `/tmp/lgtm-feedback.json` on exit:
```json
{
  "status": "submitted" | "empty-diff" | "invalid-spec" | "git-error" | "cancelled",
  "gitArgs": ["origin/main"],
  "specFile": "/tmp/spec.yaml",
  "comments": 3,
  "durationMs": 42000,
  "port": 8765
}
```

## The spec file (changesets)

When the diff is large, provide a YAML or JSON spec to group files into logical changesets. This makes the review UI organize files under section headers with descriptions.

### Spec format (YAML)
```yaml
title: "feat(auth): add OAuth2 support"

changesets:
  - name: Database Migrations
    description: Schema changes required for the OAuth2 token flow
    match:
      - migrations/*.sql
      - prisma/schema.prisma

  - name: Auth Provider
    description: Core OAuth2 provider and token exchange logic
    match:
      - src/auth/provider/*
      - src/auth/oauth2.ts

  - name: API & Middleware
    description: New auth endpoints and request middleware
    match:
      - src/routes/auth.ts
      - src/middleware/*

  - name: Tests
    description: Unit and integration tests for auth flows
    match:
      - "**/*.test.ts"
      - "**/__tests__/**"
```

### Rules
- **First match wins** — a file is assigned to the earliest changeset whose `match` globs match its path. Order changesets from most specific to most general.
- **Unmatched files** go to an automatic "Ungrouped" section.
- **Empty groups** (no files matched) are omitted from the rendered UI.
- The `title` field is optional and displayed as the review page heading.
- The `output` field exists in the type but is **not implemented** — stdout output is always JSON.

## API endpoints (for programmatic use)

If you need to interact with the server without the browser:

| Method | Path | Response |
|---|---|---|
| `GET` | `/api/diff` | `{ diff: string }` — the raw unified diff |
| `GET` | `/api/spec` | `{ spec: object \| null }` — the parsed YAML spec |
| `GET` | `/api/rich-diff` | `RichDiffResponse` — parsed diff with file grouping, hunks, etc. |
| `POST` | `/api/submit` | `{ status: "ok" }` — submits the review, then server closes |

The `POST /api/submit` endpoint does **no validation** — it accepts whatever JSON body you send and writes it to stdout.

### ReviewComment fields
| Field | Type | Required | Description |
|---|---|---|---|
| `file` | string | yes | File path (e.g. `src/auth/oauth2.ts`) |
| `line` | number | yes | Starting line of the comment |
| `side` | `"deletions"` or `"additions"` | no | Which side of the split diff the comment targets |
| `text` | string | yes | The review comment text |

### ReviewResult structure
```typescript
interface ReviewResult {
  comments: ReviewComment[];
}
```

Comments are a **flat list**. Grouping by changeset is reconstructed by matching `ReviewComment.file` against `Changeset.match` globs — lgtm does NOT output changeset grouping in the JSON. Consumers must re-apply the same glob matching logic.

## Agent workflow

### Step 1: Write the spec (THIS IS THE MOST IMPORTANT STEP)

You MUST write a YAML spec file that groups every changed file into logical changesets. This is not optional — the spec is required by the CLI and it is the primary way the human reviewer understands what you did.

**Requirements for the spec:**

1. **Group files into 2-5 logical categories.** Look at every changed file and mentally group them by purpose. Examples of good groups: "Build configuration", "CLI refactoring", "API server changes", "Tests", "Documentation".

2. **Write a detailed `description` for each changeset.** The description must explain:
   - WHAT changed (which files/types of files)
   - WHY the changes were made (the motivation/reasoning)
   - HOW the group fits into the overall diff

   A good description: `"Refactored the CLI entry point to integrate git diff directly — removed detached mode, removed the old file-based diff input, and simplified the invocation to a single blocking command with strict fail-early validation"`
   
   A bad description: `"CLI changes"` or `"Updated src/cli.ts"` or `"Misc"`

3. **No group should be called "Misc", "Other", "Ungrouped", or similar.** Every file must have a purpose. If you can't explain why a group of files belongs together, you don't understand the diff well enough — re-examine it.

4. **Order groups from most specific to most general** (first-match-wins). Put catch-all patterns like `**/*.test.ts` last.

5. **Write the spec to a temp file** (e.g. `/tmp/lgtm-spec.yaml`).

### Step 2: Stage new files

If you created any untracked files, run `git add` so they show up in the diff. If the diff produces no output, `git add` the new files and retry with `lgtm HEAD`.

### Step 3: Run lgtm

Run a single blocking command with a 10-minute timeout. This is all you do — the CLI handles git diff, validation, server start, and output.

```bash
lgtm <refs> --spec /tmp/lgtm-spec.yaml --port <n> --open
```

Capture stdout for the review JSON result. The command blocks until the user submits.

### Step 4: Check feedback

After lgtm exits, check `/tmp/lgtm-feedback.json` to understand what happened.

- `status: "submitted"` → user reviewed successfully. Parse stdout JSON and act on comments.
- `status: "empty-diff"` → git diff produced nothing. `git add` new files, retry with `lgtm HEAD`.
- `status: "cancelled"` → user hit Ctrl+C. Tell the user and offer to restart.
- `status: "git-error"` → bad refs or not a git repo. Fix and retry.
- `status: "invalid-spec"` → spec file is malformed. Fix the YAML and retry.

### Pro tip: scripting the submit

If you want to programmatically submit comments (e.g., the AI agent analyzes the diff and pre-fills comments), you can `POST` directly to the submit endpoint using `fetch` or `curl`:

```bash
curl -X POST http://localhost:$PORT/api/submit \
  -H "Content-Type: application/json" \
  -d '{"comments":[...]}'
```

The server will respond `{"status":"ok"}` and shut down, writing your payload to stdout.

## Important gotchas

1. **`git diff` hides untracked files** — the #1 mistake. `git diff` only shows changes to already-tracked files. Check with `git status`. If you have new files, `git add` them and retry with `lgtm HEAD`.
2. **Strict hunk headers** — lgtm uses the `diff` npm package's `parsePatch`, which is strict about `@@` line counts. Always generate diffs from real `git diff` output; never hand-edit hunk headers.
3. **No comment UI in browser** — the browser shows the diff read-only. Comments go through the API. The user reviews visually and tells you (the agent) what to submit, or you script the submission.
4. **stdout is always JSON** — regardless of the `output` field in the spec, stdout output is `JSON.stringify(result, null, 2)`. The `output` field is not implemented.
5. **First-match-wins grouping** — order changesets from most specific globs to most general. A file matching `src/auth/provider/*` should come before a `src/**` catch-all.
6. **No persistence** — each lgtm invocation is stateless. The server starts fresh and shuts down after submit or Ctrl+C. There's no database, no session storage.
7. **Port discovery** — the port is printed to stderr as `lgtm: http://localhost:PORT`.
8. **No validation on submit** — `POST /api/submit` blindly accepts any body. Malformed payloads will be written to stdout as-is.
9. **ESM project** — if running the dev version directly: `node dist/cli.js`. All imports use ESM syntax.

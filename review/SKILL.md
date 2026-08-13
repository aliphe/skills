---
name: review
description: Prepare and run a local human code-review session using the `review` CLI. Use after completing an implementation when the user wants to review the diff before finalizing.
---

# review

Run a local, structured human code review for a git diff.

`review` is an agent-driven CLI. The agent prepares a `.review/<session>/` workspace with context, a review plan, and section descriptions; the CLI renders the diff and captures human comments. The agent then reads `comments.json` and iterates.

> **Current implementation status:** the CLI currently validates the review workspace and exits. The interactive web UI is not yet implemented, so no human comments are captured in this version.

## When to use

- After finishing an implementation and before telling the user the task is complete.
- When the user explicitly asks to review a change, e.g. "can you prepare a review?" or "let me review this".
- When you want structured feedback on a multi-file change.

## Prerequisites

- The repo is a git repository.
- The `review` CLI is available. If it is not installed globally, run it from this project's source:
  ```bash
  bun /Users/matthias/work/perso/review/src/index.ts --session <slug>
  ```

## Steps

### 1. Generate a session slug

Create a short, filesystem-safe identifier for the review session, for example from the feature name:

- `user-creation-form`
- `auth-login-endpoint`
- `fix-race-condition-in-cache`

The slug is used as the directory name `.review/<slug>/`.

### 2. Write the context file

Create `.review/<slug>/context.md` with:

- The original task or user request.
- A summary of the implementation decisions you made.
- Any open questions or risks you want the reviewer to focus on.

Use markdown. This is the human's primary source of context.

### 3. Write the review plan

Create `.review/<slug>/plan.yaml` describing how the diff should be reviewed.

```yaml
title: User creation form
description: description.md
sections:
  - title: Entrypoints
    description: sections/entrypoints.md
    files:
      - src/main.ts
      - src/router.ts

  - title: Validation
    description: sections/validation.md
    files:
      - src/forms/validation.ts
      - src/forms/validation.test.ts
```

Rules:

- `title` is shown in the UI.
- `description` is a path to a markdown file, relative to `plan.yaml`.
- Each section's `files` list must contain paths that are present in the diff.
- Order sections in the sequence you want the human to read them.
- Diff files not assigned to any section will be placed in a catch-all "Other changes" section.

### 4. Write section descriptions

Create `.review/<slug>/sections/*.md` files referenced by `plan.yaml`.

Each description is a **changelist** — a 3-4 sentence paragraph that explains the reasoning behind a group of file changes. It is not a label; it is a brief narrative the agent writes to help the reviewer understand *why* this set of files was changed and how they fit together.

A good changelist description covers:

- **What** changed in this section (the scope of edits).
- **Why** the changes were made (the motivation or problem being solved).
- **What the reviewer should look for** (potential risks, tradeoffs, or non-obvious consequences).

You can embed images, videos, SQL queries, or diagrams using relative paths; the CLI serves the whole `.review/<slug>/` directory as static assets.

### 5. Run the CLI

```bash
review --session <slug>
```

Common overrides:

```bash
# Review a feature branch against main
review --session auth-login --base main --target auth-login-branch

# Use custom input paths
review \
  --session auth-login \
  --context-file ./docs/context.md \
  --review-plan ./docs/plan.yaml \
  --comments-path ./out/comments.json
```

The CLI validates the workspace. If validation fails, fix the plan or diff and rerun.

### 6. Read the output

If validation succeeds, the CLI prints a JSON summary to stdout, for example:

```json
{
  "session": "user-creation-form",
  "comments": 0,
  "unresolved": 0,
  "path": ".review/user-creation-form/comments.json"
}
```

In the current validation-only version, `comments` is always `0` and `unresolved` is always `0`.

### 7. Iterate (future versions)

Once the UI is implemented:

- The human reviews the diff, adds inline comments, and ends the session.
- Comments are written to `.review/<slug>/comments.json`.
- Read that file, address unresolved comments, update the workspace, and rerun `review` until all comments are resolved.

## Output format

`.review/<slug>/comments.json` contains the review feedback:

```json
{
  "session": "user-creation-form",
  "generatedAt": "2026-06-15T14:32:01Z",
  "comments": []
}
```

Location syntax for comments (used once the UI is ready):

- File-level: `src/forms/validation.ts`
- Single-line: `src/forms/validation.ts:L24`
- Line-range: `src/forms/validation.ts:L24-31`

## Best practices

- Write changelist descriptions as 3-4 sentence paragraphs with reasoning, not one-line labels.
- Group related files together so the reviewer can follow a coherent narrative.
- Do not include files in `plan.yaml` that are not in the diff; the CLI treats that as an error.
- Add `.review/` to `.gitignore` if it is not already ignored; the CLI does not do this automatically.

---
name: linear
description: Put a draft into a Linear document, have a human review it, and hand their comments back to the calling agent. Use when the user says "let's review this plan in document <url>", "put this in the doc for review", "share this with the team in Linear and collect comments", or wants a plan, PRD, spec, design or RFC circulated in a Linear document and the feedback returned before acting on it.
---

# Linear document review loop

Turns "let's review this plan in document `<url>`" into the draft living in that
document, a human review, and a summary of what the reviewers said back in the
caller.

The calling agent owns the content. This skill moves it into Linear and brings
the comments back; it does not invent the plan.

## Before you start

You need a **draft on disk** — the markdown that should end up in the document. If
the user gave you only a URL, write the draft first, from the conversation, the
ticket or the repo, and get it agreed. This skill does not draft for you.

`linear` must be on PATH and authenticated:

```bash
linear auth whoami
```

Set the helper path once:

```bash
S=~/.agents/skills/linear/scripts/linear_review.py
```

## The loop

### 1. Plan — read-only, always first

```bash
$S plan --url "<url>" --draft <draft.md>
```

Prints one JSON object. Read `verdict`:

| verdict | what it means | what you do |
|---|---|---|
| `empty` | the document has no body | write it |
| `identical` | the body already equals the draft | apply; nothing is rewritten |
| `minor` | the body differs in places | name the changed sections in one line, then write |
| `major` | the draft is largely different from the body | **stop and ask, below** |

`major` means the draft would replace most of what is already there. The JSON
carries the evidence: `sections.onlyInDocument` is what disappears,
`sections.onlyInDraft` is what arrives, `sections.changed` is what gets rewritten
in place. Show the user those three lists and let them choose, as concrete options:

- **replace** — discard the current body and write the draft.
- **merge** — keep every current section the draft does not touch, rewrite the
  headings it shares, append the new ones.
- **abort** — leave the document alone.

Nothing is written until they answer. `apply` enforces this: without `--confirmed`
it refuses a `major` draft and exits 4.

`merge` needs at least one heading in both the body and the draft. If the script
refuses the mode for that reason, say so and offer replace or abort instead.

### 2. Apply

```bash
$S apply --url "<url>" --draft <draft.md> --mode replace
# or
$S apply --url "<url>" --draft <draft.md> --mode merge --confirmed
```

Writes the body and opens the review session that `collect` measures against.
`--confirmed` is needed only after a `major` verdict, and only once the user has
chosen. `--title "…"` renames the document too; use it only if the user asked.

### 3. Hand it to the user

Say, in two or three lines, that the document is ready, with the link, and that
both comments and direct edits in the document are welcome:

> Ready for review: `<url>`. Add comments or edit the text directly, then tell me
> when you're finished and I'll summarize the feedback.

Then stop. Do not poll the document on a timer, do not re-fetch it to see whether
someone has commented yet, do not guess at the feedback. The next call in this
loop is `collect`, and it happens when the user says they are done.

### 4. Collect

```bash
$S collect --url "<url>"
```

Markdown, ready to hand back: every comment thread added since the write, with the
author, the text they quoted, the comment body and its replies; unresolved threads
first; plus a diff when the reviewer edited the body itself.

This is the deliverable. Forward it to the caller as-is, or act on it if the
caller asked you to answer the comments.

`--json` returns the same content as structured data. `--all` includes threads
already collected, for a second pass over the same review.

### 5. Close

```bash
$S end --url "<url>"
```

Closes the session once the summary is forwarded. Skip it if the user wants
another round — applying again refreshes the baseline.

## Rules

- **`plan` before `apply`, always.** The diff is the only thing standing between
  your draft and a document someone else wrote.
- **Never write a `major` draft without the user's explicit choice.** The exit-4
  refusal is the guard, not an obstacle to route around.
- **The document belongs to its authors.** You write the body only through
  `apply`. You never delete, rename or re-parent the document, and you never post
  comments or replies to it.
- **One session per document.** Re-running `apply` on an open session replaces the
  baseline; it does not stack sessions.
- **Do not summarize from memory.** `collect` reads Linear. What arrived after the
  write is exactly what the reviewer said.
- The draft is markdown, and so is the document: headings in both are what make
  `merge` and the section diff meaningful.
- For anything this skill does not cover — issues, projects, raw GraphQL — the
  `linear-cli` skill has the rest.

## State

One JSON file per document under `~/.pi/agent/state/linear-review/<document-uuid>.json`,
holding the write baseline, the comment ids that existed at write time, and the ids
already collected. It is a scratchpad: deleting a file only means the next `apply`
starts a fresh review. `linear_review.py sessions` lists what is open, and
`LINEAR_REVIEW_STATE_DIR` moves the directory.

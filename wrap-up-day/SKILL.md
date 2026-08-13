---
name: wrap-up-day
description: End-of-day report of what was built across all of today's opencode sessions. Use when the user says "wrap up the day", "wrap-up-day", "summarize today", "what did I do today", "end of day report", or wants a recap of today's work across sessions.
---

<what-to-do>

## Step 1 — Find opencode's session data

opencode stores sessions in a SQLite database. Default location:

```
~/.local/share/opencode/opencode.db
```

If that file doesn't exist, fall back to the legacy JSON layout (see <supporting-info>). Never copy or dump the whole DB into context — it's multi-GB. Always query with the `sqlite3` CLI.

## Step 2 — Find today's sessions

Sessions are rows in the `session` table. `time_created`/`time_updated` are epoch **milliseconds**. "Today" means the current local calendar day.

```bash
DB=~/.local/share/opencode/opencode.db
sqlite3 "$DB" "
SELECT id, title, directory, model, agent, cost,
       datetime(time_created/1000,'unixepoch','localtime') AS created,
       datetime(time_updated/1000,'unixepoch','localtime') AS updated
FROM session
WHERE time_updated >= strftime('%s', datetime('now','localtime','start of day'), 'utc') * 1000
ORDER BY time_updated;"
```

Keep sessions with real activity — edits, builds, meaningful work. A single Q&A exchange with no edits usually gets one line at most, if any. The current, still-open session is included.

## Step 3 — Extract what was built, per session

For each session (`S=ses_...`):

1. **What the user asked** — the first user text prompts:

```bash
sqlite3 "$DB" "
SELECT json_extract(p.data,'$.text') FROM part p
JOIN message m ON m.id = p.message_id
WHERE m.session_id='$S'
  AND json_extract(m.data,'$.role')='user'
  AND json_extract(p.data,'$.type')='text'
ORDER BY m.time_created LIMIT 3;"
```

2. **What files changed** — every file edited or written:

```bash
sqlite3 "$DB" "
SELECT DISTINCT json_extract(p.data,'$.state.input.filePath') FROM part p
WHERE p.session_id='$S'
  AND json_extract(p.data,'$.type')='tool'
  AND json_extract(p.data,'$.tool') IN ('edit','write');"
```

3. **What the assistant concluded** — the last assistant text part. Also useful on the session row: `summary_files`, `summary_additions`, `summary_deletions`.

4. If the session's directory is a git repo, `git -C <dir> log --since=midnight --pretty=oneline` reveals what was committed today.

## Step 4 — Write the report

Small, skimmable markdown. Start with the date, then one short section per session:

- **Session title** — directory
- 1–3 bullets on what was built (drawn from the prompts, changed files, and final summary)
- Key files touched, paths shortened (`apps/web/src/components/TopBar.tsx`)
- Cost / model, only if it adds value

Keep each section to a few lines. No long quotes or diffs. Close with a 2–3 line overall summary of the day.

</what-to-do>

<supporting-info>

## Legacy JSON storage

Older opencode versions kept sessions as JSON files:

- `~/.local/share/opencode/storage/session/<project-id>/ses_*.json` — metadata (`time.created`/`time.updated` in epoch ms, `title`, `directory`)
- `~/.local/share/opencode/storage/message/<session-id>/msg_*.json` — messages
- `~/.local/share/opencode/storage/part/<message-id>/prt_*.json` — parts (text, tool calls, edits)

If the SQLite DB is missing, find today's `ses_*.json` files (`find ... -newermt "today"`), then read their message/part JSON with `jq` to rebuild the same report. Don't mix the two layouts.

## Prefer structure over volume

The goal is a digest, not a log. If a session touched 30 files, list the meaningful ones (handlers, components, migrations) — not every `package.json` diff. When in doubt, ask the user what level of detail they want.

</supporting-info>

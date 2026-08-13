---
name: proto-workshop
description: Spin up a throwaway prototype branch in the skipr, maas, or backoffice frontends for PMs and designers. Creates a branch from origin/development, discusses the prototype with the user (accepts markdown descriptions or screenshots), patches the .env to point at staging instead of localhost, makes the UI changes, and starts the dev server. Use when a PM or designer says "prototype", "proto", "mock this up", "build a quick UI for this", or shares a design description and wants to see it running.
---

# Proto Workshop

Quickly materialise a UI prototype from a PM or designer brief. The flow is: branch → discuss → env-patch → code → run.

The skill supports all three frontend apps:

| App | Port | Serve command |
|---|---|---|
| **skipr** (web dashboard) | 4201 | `pnpm nx run skipr:serve` |
| **maas** (mobile web) | 4200 | `pnpm nx run maas:serve` |
| **backoffice** (internal) | 4202 | `pnpm nx run backoffice:serve` |

All commands run from `frontend/` unless noted otherwise.

## Phase 1 — Intake

Ask in a single call (one question per axis):

1. **App**: which of `skipr`, `maas`, or `backoffice`?
2. **Brief**: paste a markdown description, share screenshot paths, or describe in free text what they want to see on screen. If they paste a Linear URL, read the issue/project description. Accept anything.
3. **Branch name** (optional): suggest one yourself as `proto/<short-slug>` if they don't have a preference.

Do not start coding yet. Fully understand the brief first.

## Phase 2 — Create the branch

```bash
# From repo root
git fetch origin
git checkout -b <branch-name> origin/development
```

Confirm the branch is active:

```bash
git branch --show-current
```

If `origin/development` doesn't exist (renamed or offline), fall back to `origin/main` and tell the user.

## Phase 3 — Patch the .env

The apps use `.env` files to configure the API base URL. The golden rule: **the prototype must hit staging, never localhost**, so the PM or designer sees real data shapes without needing the full backend stack.

### 3a. Read the current .env

Each app has its own `.env` at:

| App | Path |
|---|---|
| skipr | `frontend/apps/skipr/.env` |
| maas | `frontend/apps/maas/.env` |
| backoffice | `frontend/apps/backoffice/.env` |

Read it now — do not guess the variable names. The file may also have a sibling `.env.local` or `.env.development`; if those exist, read them too. The one with highest Next.js precedence wins (`.env.local` > `.env.development` > `.env`).

For backoffice, also check `frontend/apps/backoffice/envs/` for existing environment presets (e.g. `skipr-staging.env`). If a staging preset already exists there, prefer copying it rather than hand-patching.

### 3b. Identify the API URL variable

Look for any variable whose value looks like `http://localhost:*` or `http://127.0.0.1:*`. Common names (non-exhaustive — read the file, don't guess):

- `NEXT_PUBLIC_API_URL`
- `NEXT_PUBLIC_BACKEND_URL`
- `NEXT_PUBLIC_BASE_URL`
- `API_URL`
- `NX_API_URL`

There may be more than one (e.g. separate auth service URL, translation service URL). Identify **all** localhost URLs, not just the first one.

### 3c. Find the staging equivalents

**Do not invent staging URLs.** Derive them from what's in the file:

1. If the file already contains commented-out staging values (e.g. `# NEXT_PUBLIC_API_URL=https://api.staging.skipr.co`) — use those.
2. If another env file in the same directory (e.g. `.env.staging`, `skipr-staging.env`) has the same variable with a non-localhost value — use that value.
3. If there's no hint in any env file, ask the user for the staging base URL before proceeding. Do not make up a URL.

### 3d. Apply the patch

**Do not overwrite the whole file.** Only replace localhost values with their staging equivalents. If you're unsure whether a variable should be changed (e.g. a websocket URL, a feature-flag URL, a firebase config), ask rather than guess.

Write a `.env.proto` file alongside the `.env` (e.g. `frontend/apps/skipr/.env.proto`) that contains only the changed lines — this acts as a visible diff and makes it trivial to revert:

```
# Proto Workshop patch — staging overrides
# Original .env values are left unchanged; Next.js loads this file with higher precedence
NEXT_PUBLIC_API_URL=https://api.staging.skipr.co
```

For **Next.js apps** (skipr, maas): name it `.env.local` — Next.js loads `.env.local` with highest precedence in dev mode. If `.env.local` already exists with real content, read it first, merge the staging overrides into it, and tell the user what changed.

For **backoffice** (webpack): the mechanism is different — environment variables are baked in at build time via `fileReplacements` or Angular-style `environment.ts`. Check `frontend/apps/backoffice/src/environments/environment.ts` and `environment.prod.ts`. If there's a `apiUrl` field pointing to localhost, propose patching it directly (with confirmation) or using the existing staging env preset if one exists in `envs/`.

### 3e. Confirm with the user

Show a compact diff of every variable you changed before writing. Ask: "Apply these overrides and run against staging?"

Do not write anything until the user confirms.

## Phase 4 — Discuss and plan the changes

Before touching any component code, present a short plan:

- Which pages/components will be touched.
- What will be added/changed/removed.
- Any data that needs to be wired to a real API call vs. mocked locally (for prototypes, mocking is fine — say so explicitly).
- Any i18n considerations: hardcode strings, then remind the user to add them to the Google Sheet later (see `frontend/AGENTS.md` § I18n Rules).

Ask: "Does this match what you had in mind, or should we adjust the scope?" Resolve any ambiguities before writing a line of code.

If the brief includes screenshots or images, use the `linear_extract_images` tool (or read them from disk if paths were provided) to inspect them before planning.

## Phase 5 — Make the changes

Follow `frontend/AGENTS.md` in full. Key reminders:

- **Code style**: `Props` interface at top, newspaper principle, section comments (`// Attributes`, `// Render`, etc.), `rem` for sizing, theme colors.
- **No new i18n keys**: hardcode string literals, then surface a TSV block for the Google Sheet.
- **NX boundaries**: respect lib scopes (`maas`, `skipr`, `backoffice`, `shared`).
- **Prototype quality**: it's fine to stub data and skip error states — but say so in a `// PROTO:` comment so the developer knows what to harden later.
- **No console.log, no commented-out code, no unused imports.**

If the prototype needs a new page, add it to the correct `pages/` or `app/` directory for the target app.

For mock data, define it as a typed constant in the component file with a `// PROTO: replace with real query` comment.

## Phase 6 — Start the dev server

```bash
# From frontend/
pnpm nx run <app>:serve
```

| App | Full command | URL |
|---|---|---|
| skipr | `pnpm nx run skipr:serve` | http://localhost:4201 |
| maas | `pnpm nx run maas:serve` | http://localhost:4200 |
| backoffice | `pnpm nx run backoffice:serve` | http://localhost:4202 |

Run in the foreground so the user sees compile output. If the port is already in use:

```bash
lsof -ti :<port> | xargs kill -9 2>/dev/null
```

Then retry.

Wait for the "compiled successfully" (Next.js) or "webpack compiled" (backoffice) message before telling the user the app is ready.

Tell the user:
1. The URL to open.
2. The branch name.
3. That the app is hitting staging (`NEXT_PUBLIC_API_URL` or equivalent — state the actual value used).
4. Any hardcoded strings that need i18n keys (as a TSV block, ready to paste into the Google Sheet).

## Phase 7 — Iterate

Stay in the session. After the user gives feedback:

- Small changes (text, colour, layout) → make them directly and the dev server hot-reloads.
- Structural changes (new components, new pages) → re-run the plan step (Phase 4 abbreviated) and confirm before coding.

When the user is happy: remind them that the branch is `<branch-name>`, the `.env.local` patch should be reviewed before opening a PR (staging URLs must not land in production config), and the hardcoded strings need i18n treatment.

Do not open a PR, commit, or push unless the user explicitly asks.

## Anti-patterns

- **Guessing staging URLs.** If you can't derive the staging URL from existing files, ask. Never invent a URL.
- **Overwriting .env wholesale.** Patch only the localhost overrides; leave everything else intact.
- **Using `any` or disabling TypeScript.** Even for prototypes — `unknown` and a type assertion are better.
- **Forgetting the `// PROTO:` comment** on stub data. The developer hardening this later needs to know what was mocked.
- **Starting the server before confirming the env patch.** The whole point is staging, not localhost — confirm first.
- **Touching backend code.** This skill is frontend-only. If the prototype requires a new backend endpoint, note it as a future dependency with a `// PROTO: needs endpoint <description>` comment and mock the data.
- **Committing or pushing without being asked.** The branch is the user's to inspect first.

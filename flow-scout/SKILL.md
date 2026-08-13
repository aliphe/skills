---
name: flow-scout
description: Pre-explore a UI flow in the skipr web dashboard or the maas mobile web app before a real task — writing a Playwright test, planning a refactor, reproducing a bug, documenting a flow. Brings up the local stack, mints an x-test-id, drives Chrome via the chrome-devtools MCP, and dumps a Markdown observation log to /tmp/flow-scout/. When the flow breaks because of a missing/broken seed, diagnoses the gap against the live PostgreSQL clone and proposes a concrete seed-data patch the developer can confirm and apply. Use when the developer says "scout this flow", "flow-scout", "let me scout the X flow before I write the test", "explore the UI for X", "preshot this", "recon this page", "walk me through the UI for Y before I start", or otherwise asks to pre-explore a frontend flow before doing the real work. Produces observations only — never writes test code.
---

# Flow Scout

Pre-explore a single skipr web-dashboard OR maas mobile-web flow and produce a structured observation report. Quiz the developer briefly, bring the local stack up, drive Chrome via the chrome-devtools MCP, record everything that happens (selectors, wording, network calls, errors), and on a confirmed seed-data gap propose a concrete fix and (if accepted) apply it and retry.

The skill is **scouting, not authoring**. You do not write test code. You do not modify frontend component code. The only places you may modify checked-in code are under Phase 6 with explicit developer confirmation on a shown diff: (a) adding a new seeder file in `backend/api/web/testcontroller/` that registers itself with the single `POST /test/seed` dispatcher, or (b) editing a master-template seed file in `backend/srv/<service>/repository/db/seeds/`. Everything else is observation.

This skill supports the **`skipr` web dashboard** (port 4201) and the **`maas` mobile web app** (port 4200). `backoffice` is not supported. The two apps share the same backend stack but differ in auth wiring and login form — see Phase 2 (stack) and Phase 4 (login) for per-app specifics.

## When to use this skill

- Developer asks to "scout", "flow-scout", "preshot", "recon", "explore", or "walk through" a UI flow before doing real work.
- Before writing a Playwright integration test against the seeded backend.
- Before refactoring a page and wanting to know what's actually on it.
- When reproducing a bug and wanting a clean trace of clicks + network activity.

## When NOT to use this skill

- The developer wants you to write the actual `*.spec.ts` — that's a separate task.
- The developer wants UI changes — modify the component code directly.
- The flow lives in `backoffice` — out of scope.
- The developer wants a generic codebase explanation — use `Explore` agents instead.

## Required reading before you start

Read these once at the start of every invocation. They are the source of truth for the workflow primitives this skill orchestrates:

- `LOCAL-STACK.md` (repo root) — the stack: seeded data, the `/test/seed` mechanism, troubleshooting, the Firebase emulator section (maas), and the `?x-test-id=` rule.
- `frontend/docs/e2e.md` § "Full-stack mode" — the chrome-devtools MCP selector-debugging workflow.
- `frontend/apps/skipr-e2e/playwright.config.ts` OR `frontend/apps/maas-e2e/playwright.config.ts` — read `credsFull` for the seeded password. Do not hardcode the password in this skill.
- For skipr flows: `frontend/apps/skipr-e2e/src/integration/auth.helpers.ts` (login form + `SEEDED_*` constants) and `auth.fleet-setup.ts` (cookie-swap for non-employee roles).
- For maas flows: `frontend/apps/maas-e2e/src/integration/auth.helpers.ts` (login form, `SEEDED_LITE_*` constants, Capacitor `storageKey` helper) and `auth.lite-setup.ts` (localStorage swap for the lite-org variant).

If any of these files have moved or changed shape, stop and ask the developer before guessing.

## Process

### Phase 1 — Quiz the developer

Use `AskUserQuestion`. Ask everything in **one** call (one question per axis) so the developer answers in one screen:

1. **App**: `skipr` (web dashboard, default) / `maas` (mobile web).
2. **Role / org variant** (only asked when relevant):
   - For skipr: `EMPLOYEE` (default) / `FLEET_MGR` / `REVIEWER`.
   - For maas: `full-org` (default, the BeOrganisation — banking/payment-card enabled) / `lite-org` (BeLiteOrganisation — banking/payment-card disabled).
3. **Flow input**: paste a URL, or describe the flow in one sentence ("create a manual spending and submit it"). For verbal descriptions, you discover the entry point from `/dashboard` (skipr) or `/home/dashboard` (maas) yourself in Phase 4.
4. **Capture FR strings too?** Default no. Yes means you walk the flow a second time with `skipr-language=fr` (skipr) or `document.cookie = "NEXT_LOCALE=fr"` / localStorage language setter (maas — verify in the auth-helpers before assuming).
5. **Purpose** (optional one-liner): test, refactor, bug repro, docs. Shapes what you emphasise in the report. Not load-bearing.

You drive the browser; the developer watches.

### Phase 2 — Bring up the stack

Check what's already running before doing anything:

```bash
curl -sf http://localhost:8084/test/db/setup -X POST -o /dev/null -w "%{http_code}"
```

If it returns `200`, the backend is up. If it returns `404`, the backend is up but `--enable_test_routing` is off — stop and tell the developer. If `curl` fails to connect, the backend is down.

If the backend is down: `scripts/e2e-local.sh --app=<app> --skip-build --skip-frontend --project=e2e-integration-smoke` (the cheapest documented bring-up path — see `LOCAL-STACK.md`). For `--app=maas` this additionally waits for the Firebase emulator + seeder. Blocks for ~30-60s while Consul registrations settle. Run it foreground; you need to know when it's done.

Check the dev server (port depends on app):

```bash
# skipr → :4201
curl -sf http://localhost:4201 -o /dev/null -w "%{http_code}"
# maas  → :4200
curl -sf http://localhost:4200 -o /dev/null -w "%{http_code}"
```

If it's not 200, start it in the background:

```bash
# skipr
cd frontend && PORT=4201 pnpm nx run skipr:run-from-dist &
# maas
cd frontend && PORT=4200 pnpm nx run maas:run-from-dist &
```

This requires a prior build of the matching app — if the dist is missing, the e2e script (run without `--skip-frontend`) builds it. Wait for the port to return 200 before continuing.

**Stale-server trap** — Playwright's `reuseExistingServer: !CI` uses any Next server already on the port. If you rebuilt the frontend while an older `next-server` is running, it will 404 today's content-hashed chunks (`_app-*.js`, `_buildManifest.js`) and every test/navigation will stall on a blank spinner. Probe and kill if necessary:

```bash
ps -o pid,etime,cmd -p $(pgrep -f 'next-server') 2>/dev/null
# If ELAPSED predates your last build: pkill -f next-server
```

**Sanity-check the stack before continuing.** Backend port 200 only proves api-web is up — downstream services (srv-payment, srv-budget, srv-organisation, etc.) can be in restart loops or unregistered with Consul, and you will only discover this much later when a specific endpoint silently returns 200/empty or 500. Catch it now:

```bash
echo '--- container states (anything not "Up X" is suspect):'
docker ps --format 'table {{.Names}}\t{{.Status}}' | grep -E 'local-|skipr-'

echo '--- consul-registered services:'
docker exec skipr-consul consul catalog services
```

Compare the registered services to the running containers. The expected service set is roughly: `api-web`, `api-callbacks`, `srv-authentication`, `srv-budget`, `srv-expense`, `srv-invoicing`, `srv-notification`, `srv-organisation`, `srv-payment`, `srv-product`, `srv-routing`, `srv-translation`, `srv-treezor`. If a container shows `Restarting` or is missing from the Consul catalog, **stop and surface this to the developer in chat before going further**: name the service, give the last few log lines (`docker logs --tail 30 <container>`), and ask whether to (a) attempt a fix, (b) proceed knowing that endpoints touching that service will fail, or (c) abort. Do not silently proceed — a crashed service produces ambiguous symptoms (200/empty responses, missing data) that look like seed gaps but aren't, and they will burn 15+ minutes of false-trail diagnosis later.

Common failure mode caught here: `srv-payment` fatal-loops on a missing NMBS TLS cert, returning `service srv-payment: not found` to api-web for `/payment_methods` and silently empty lists for `/splittable_transactions`. Recent commit `c3ae67212a` made it boot without the cert; if that's been reverted, expect this.

**For maas flows: also verify the Firebase Auth emulator + seeder.** The maas sign-in flow uses `auth().useEmulator('http://localhost:9099')` and the backend's mock Firebase provider won't accept tokens for users the emulator never provisioned. Without both of these, `auth.setup.ts` times out with `/web/v2/me` → 401:

```bash
curl -sf http://localhost:9099/ >/dev/null && echo "✓ emulator" || echo "✗ emulator DOWN"
docker inspect -f '{{.State.Status}} exit={{.State.ExitCode}}' local-firebase-auth-seeder-1 2>/dev/null
# Expect: "exited exit=0"
```

If either is missing, start them: `docker compose -f backend/deployment/local/docker-compose.yml -f backend/deployment/local/docker-compose.services.yml up -d firebase-auth-emulator firebase-auth-seeder`.

### Phase 3 — Mint an `x-test-id`

```bash
curl -X POST http://localhost:8084/test/db/setup
```

Capture the returned `test_id` UUID. **Surface it in every report** so the developer can teardown manually later.

**Critical rule for the rest of the run**: append `?x-test-id=<uuid>` to **every** URL you navigate to, alongside any other query params. Not just the first navigation. The frontend reads the param once per navigation and attaches the `X-Test-Id` header to outbound backend requests from that page; without it you hit the un-isolated DB and get cryptic "Email unknown" errors at login. See `LOCAL-STACK.md` § "Running an app against the stack".

### Phase 4 — Drive the flow

Set up the browser:

1. `mcp__chrome-devtools__list_pages` — reuse a blank page if one exists, else `mcp__chrome-devtools__new_page`.
2. Set the language before navigating. skipr uses a cookie, maas uses localStorage — copy from the matching `auth.helpers.ts` rather than guessing.
3. Navigate to:
   - skipr: `http://localhost:4201/auth/sign-in?x-test-id=<uuid>`
   - maas: `http://localhost:4200/home/dashboard?x-test-id=<uuid>` — the AuthProvider bounces unauthenticated users to `/auth/sign-in` itself.

**skipr login** (mocked auth — plain email+password form):

1. If a "Accept cookies" button is visible, click it.
2. `mcp__chrome-devtools__fill` on `input#email` → `benoit+orgbe+e2e+ci@skipr.co`.
3. Click button "Continue".
4. `mcp__chrome-devtools__fill` on `input#password` → password from `credsFull` in `frontend/apps/skipr-e2e/playwright.config.ts` (read at runtime).
5. Click button "Log in".
6. `mcp__chrome-devtools__wait_for` text like `["Dashboard", "Hello Benoit"]`.

**First-login bounce** — in a fresh browser session, the first "Log in" click often redirects back to `/auth/sign-in` with the form reset. `sessionStorage["x-test-id"]` hasn't been populated until after a round-trip, so the first `/me` call misses the isolated DB and the AuthProvider bounces. Refill the form and click again; the second attempt lands on `/dashboard`. Don't conclude login is broken on the first bounce — verify `sessionStorage` is populated, then retry.

For `FLEET_MGR` / `REVIEWER`, after login set **both** cookies via `evaluate_script` (per `auth.fleet-setup.ts`):

```js
document.cookie = "current-membership-id=<role-id>; path=/; domain=localhost";
document.cookie = "skipr-organisation-id=eed6b20b-ea3f-41e2-be60-d543ad635aa0; path=/; domain=localhost";
```

Where `<role-id>` is:
- `FLEET_MGR` → `a1b2c3d4-0000-4000-a000-000000000001`
- `REVIEWER` → `a1b2c3d4-0000-4000-a000-000000000002`

**maas login** (real Firebase SDK against the local emulator — email → Continue → password → Log in):

1. Fill `input#email` → `benoit+orgbe+e2e+ci@skipr.co`.
2. Click button "Continue" — triggers an `/web/v2/auth/configuration/email/...` lookup. Wait for the password input to appear before proceeding.
3. Fill `input#password` → `Azerty1996??` (read from `credsFull.password` in `frontend/apps/maas-e2e/playwright.config.ts`).
4. Click button "Log in".
5. `mcp__chrome-devtools__wait_for` text like `["Transactions", "Buy a ticket", "Payment methods"]` — the dashboard landmarks.

For the **lite-org variant**, after login swap the org/membership localStorage keys (per `auth.lite-setup.ts`). Note that maas uses Capacitor's `CapacitorStorage.<prefix>.<name>` key convention — read `storageKey()` in `frontend/apps/maas-e2e/src/integration/auth.helpers.ts` for the exact prefix:

```js
// Verify the prefix at runtime before hardcoding — the default build
// is `DEFAULT.local` but can differ by env.
const prefix = 'CapacitorStorage.DEFAULT.local';
localStorage.setItem(`${prefix}.skipr-organisation-id`,    'e2e0b17e-0000-4000-a000-000000000001');
localStorage.setItem(`${prefix}.current-membership-id`,    'e2e0b17e-0000-4000-a000-000000000002');
```

Reload so the AuthProvider re-reads and /me resolves to the lite membership.

**maas-specific gotchas when driving flows:**

- **Tabs pre-render hidden panels.** The `/transactions` page renders one list per program tab (Budget Mobilité / Monthly / Quarterly / Yearly) and hides inactive ones via CSS. A bare `getByText('15,00')` often resolves to a 0-size hidden clone before the visible row. Scope by the row's accessible name (`getByRole('button', { name: /Manual expense -15,00/ })`) or snapshot the a11y tree to see which entries are actually visible.
- **SVG `<title>` traps.** Expense icons render with an SVG `<title>` like `"recurring-expense-icon"` that matches loose regex text selectors at 0×0 size. Prefer role-based selectors (buttons, headings) or exact text anchors.
- **`waitForURL` with background polling.** Some routes (e.g. `/card/access/temporary-access-code`) have continuous polling that keeps the `load` event from firing, making `waitForURL(..., { until: 'load' })` time out even after the URL updates. Prefer `waitFor` on a stable element from the target page.
- **navigation wait conditions.** Post-action redirects land on different routes than the skipr equivalents: manual-spending delete → `/transactions`; recurrence delete → `/home/dashboard`. Verify via a first MCP walkthrough before hardcoding.
- **Accordion summary vs inner trigger.** Detail pages wrap each accordion in a chakra "card" button that contains both the summary text AND the inner accordion. Both match the same `getByRole('button', { name: /Description/i })`. Only the accordion has `aria-expanded`; pick it with `{ expanded: false }` in the role locator.
- **Two-step edit: Continue stages, Submit persists.** On detail pages, closing an edit accordion via "Continue" only stages the change locally; status flips to "Awaiting submission" and a separate "Submit" button appears. The PUT to the backend only fires on Submit. When recording an edit flow, wait on the PUT, not on the inner button click.
- **Editable rows only.** Manual expenses are the only editable/deletable type in the seeded portfolio; APP/CARD/IBAN rows silently reject edits and deletes. Filter row selectors to `/Manual expense/` when the scouted flow involves writes.
- **Fixed-OTP backdoor for card flows.** `srv-organisation.generatePassword()` returns `000000` for users whose phone matches `USER_TEST_PHONE_NUMBER` — the seeded e2e user's phone (`+32475000001`) is set to satisfy this, so any card-access PIN flow can hardcode `000000`.
- **Auto-invoked `testId` fixture.** In the maas integration base (`apps/maas-e2e/src/integration/base.ts`), the fixture is marked `{ auto: true }` — every test gets the X-Test-Id header interceptor whether it destructures `testId` or not. In skipr, destructuring is still required.

Then navigate again (with `?x-test-id=<uuid>` appended) so the new membership takes effect.

Walk the flow:
- If the developer gave a URL, navigate there (with `?x-test-id=<uuid>`).
- If the developer gave a verbal description, take a `mcp__chrome-devtools__take_snapshot` of `/dashboard`, reason about the right entry point from the visible navigation, and click in.

`mcp__chrome-devtools__take_snapshot` at every meaningful state change — that's where you read the a11y tree to derive selector candidates.

### Phase 5 — Observe and record

Maintain an in-memory log as you go. After each step, record:

- **Action** — plain English, what a human would say happened. "Click 'Create spending' button top-right of dashboard."
- **Element wording** — visible text + `aria-label` + `role` from the snapshot. If FR capture was opted in (Phase 1), do a second pass after the EN run with `skipr-language=fr` and capture both.
- **Selector candidates** — raw observations, ranked. Do **not** prescribe a test pattern. Order:
  1. `getByRole('<role>', { name: '<accessible name>' })`
  2. `getByLabel('<label>')`
  3. `getByText('<exact text>')`
  4. `getByTestId('<id>')` if the element already has a `data-testid`
  5. CSS fallback (e.g. `input#email`)
  
  If nothing accessible exists, flag the likely component file (best guess from URL + visible text) under "needs `data-testid` added". Do not add the testid yourself — that's the developer's call.
- **Network requests** — after each action, `mcp__chrome-devtools__list_network_requests`. Record method, URL, status. For non-2xx, also tail the api-web container:
  ```bash
  docker logs --tail 100 "$(docker ps --format '{{.Names}}' | grep -iE 'local-api-web|booking-api' | head -1)" 2>&1 | grep -iE 'error|fail|panic' | tail -20
  ```
- **Console messages** — `mcp__chrome-devtools__list_console_messages`, filter to errors and warnings. Drop info/debug noise.
- **Roadblocks & error toasts** — any visible toast/alert/dialog that blocks or changes the flow. Capture the **exact text**. **Take a screenshot** at error moments (and only at error moments — no routine-step screenshots): `mcp__chrome-devtools__take_screenshot`, save to `/tmp/flow-scout/<run-slug>/step-<N>-error.png`, link from the report.

### Phase 6 — Diagnose seed-data gaps and propose fixes

When a flow breaks because the seed isn't right (signal: a 5xx with a backend log line like "invalid input syntax for type uuid: \"\"", a required field missing from a 2xx response, or an empty list where data was expected), do not just record "broken". Diagnose, then propose the **right tier** of fix.

**Three tiers, in strict order of preference.** Start at Tier 1; only fall down if the tier above doesn't fit.

| Tier | When | Cost |
|---|---|---|
| **1. Use an existing `/test/seed` entity** | State varies per-test AND a seeder for this entity is already registered (see `LOCAL-STACK.md` § "Per-test fixture endpoint") | Zero — one HTTP call into the clone DB |
| **2. Register a new `/test/seed` entity** | State varies per-test AND no seeder exists yet | New Go file in `backend/api/web/testcontroller/seed_<entity>.go` that registers itself via `init()`. The route itself doesn't change — one `POST /test/seed` dispatches by body. Recipe in `LOCAL-STACK.md` § "Adding a new entity" |
| **3. Edit the master-template seed** | State belongs in **every** test's baseline and would not break existing tests | Edit `seeds.go`, drop master template via `psql`, restart `web-api`. Slow ritual, affects all tests |

**Default to Tier 1 or 2.** Tier 3 is the heavy hammer — only reach for it when the missing data is genuinely universal. Most state is per-test.

**Diagnosis steps — always do these first, regardless of tier.**

1. **Cross-reference known gaps.** If the failure looks like a seed limitation (an empty list where data is expected, an unsupported flow) rather than a real bug, say so instead of proposing a fix blindly.
2. **Inspect the live test-clone DB directly.** You have direct access. Use it before guessing. Clone DB name is `e2e_$(date +%F)_<test-id>`:
   ```bash
   CLONE="e2e_$(date +%F)_<test-id>"
   PGPASSWORD=local psql -h 127.0.0.1 -p 8201 -U local -d "$CLONE" -c '\d "srv-<service>".<table>'
   PGPASSWORD=local psql -h 127.0.0.1 -p 8201 -U local -d "$CLONE" -c 'SELECT … FROM "srv-<service>".<table> WHERE …'
   ```
3. **Check which `/test/seed` entities are already registered.**
   ```bash
   grep -n 'seeders\["' backend/api/web/testcontroller/seed_*.go
   ```
   This is the Tier 1 / Tier 2 fork.
4. **Read the failing service's logs.**
   ```bash
   docker logs --tail 200 "$(docker ps --format '{{.Names}}' | grep -iE 'local-api-web|booking-api' | head -1)" 2>&1 | grep -iE 'error|fail|panic' | tail -30
   ```
   For non-api-web services, `docker ps --format '{{.Names}}'` and pick the right one.

**Then pick the tier and compose the proposal.**

**Tier 1 — existing entity.** Read the seeder file (e.g. `backend/api/web/testcontroller/seed_pto.go`) for the `data` struct shape. Propose the call as a one-liner the test (or shell) will make:
```ts
await page.request.post(`${BACKEND_URL}/test/seed`, {
  headers: { 'X-Test-Id': testId, 'Content-Type': 'application/json' },
  data: { entity: '<entity-name>', data: { /* from the seeder's data struct */ } },
});
```
No code changes — you're just telling the developer which entity to use.

**Tier 2 — new entity.** Compose a new `seed_<entity>.go` following the `seed_pto.go` pattern:
- Define a `<entity>Data` struct with every field as an optional pointer (so missing = default).
- Write `seedXyz(db *gorm.DB, raw json.RawMessage) (string, error)`: unmarshal, fill defaults, `INSERT` into the schema-qualified table, return the new id.
- Register in an `init()`: `seeders["<entity_name>"] = seedXyz`.

**No changes to `seed.go`, `main.go`, or any route list** — the dispatcher picks up new entries via `init()`. Just one new file. Show the developer the diff + the rebuild ritual:
```bash
cd backend && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /tmp/api-web ./cmd/api/web
docker cp /tmp/api-web local-api-web-1:/app/bin/api/web
docker restart local-api-web-1
```
**No template drop needed** — the master template isn't touched.

**`docker restart` vs `docker compose up -d --force-recreate`** — a plain `docker restart` reuses the existing container's environment. If your change requires a **new env var** (e.g., editing `x-docker-env` in `docker-compose.services.yml` to add a `SKIP_*` flag), restart is a no-op. You need `docker compose -f docker-compose.yml -f docker-compose.services.yml up -d --no-build <service>` to recreate the container with the new env. But recreate also wipes any `docker cp`'d binary, so the correct order is: **recreate first → `docker cp` new binary → `docker restart` to load it**. Only needed when env changed; pure binary swaps don't require recreate.

**Tier 3 — master-template seed edit.** Locate `backend/srv/<service>/repository/db/seeds/seeds.go` and `constant.go`. Compose a diff against the seed file. Show the post-edit ritual from `LOCAL-STACK.md` § "Adding new seed data":
```bash
PGPASSWORD=local psql -h 127.0.0.1 -p 8201 -U local -d testing -c \
  "ALTER DATABASE \"tmpl_e2e_master_<hash>\" IS_TEMPLATE false; DROP DATABASE \"tmpl_e2e_master_<hash>\";"
docker restart "$(docker ps --format '{{.Names}}' | grep -iE 'local-api-web|booking-api' | head -1)"
```
(Look up the actual template name with `\l` first.) Existing tests must still pass — grep for uses of the entity in `frontend/apps/skipr-e2e/src/integration/` before proposing.

**Confirmation gate — every tier.** Show the developer the concrete proposal (call for Tier 1, file diffs for Tier 2/3) and ask: "apply and retry?"
- **Yes** → apply, rebuild if Tier 2, drop-template + restart + mint new `x-test-id` if Tier 3, re-walk the flow. Record both runs in the report (the failed first run + the successful retry).
- **No** → record the proposal verbatim under "Recommended fixes" in the report and continue (or stop, if the broken step blocks everything downstream).

This is the **only** place this skill writes code. Bounded scope: Tier 2 writes a new `seed_<entity>.go` seeder file (self-registering via `init()`); Tier 3 edits a master-template seed file. Never test code, never component code. Always behind a confirmation prompt. Always with a shown diff.

### Phase 7 — Decide when the flow is done

Hybrid termination:

- **Agent proposes** — when you hit an obvious terminal state (success toast, redirect to a confirmation page, no new network activity for 2 consecutive steps), stop and ask: "I think we're done — captured N steps ending at `<final URL>`. Confirm or keep going?"
- **Otherwise** — after each step, ask: "Continue, or done?" Developer always has the final say.

Do not silently decide the flow is complete. The developer always confirms.

### Phase 8 — Write the report

Create `/tmp/flow-scout/` if it doesn't exist. Write the report to:

```
/tmp/flow-scout/skipr-<role>-<flow-slug>-<YYYYMMDD-HHMMSS>.md
```

If you took screenshots, they live under `/tmp/flow-scout/<run-slug>/step-<N>-error.png` (same slug as the report basename, minus the `.md`).

### Report template

```md
# Flow Scout — <flow summary in one sentence>

## Run metadata

- **Role**: EMPLOYEE | FLEET_MGR | REVIEWER
- **Routes visited**: /dashboard → /spendings/new → ...
- **x-test-id**: <uuid>
- **Timestamp**: 2026-04-23 14:32 CET
- **Stack state**: brought up by skill | already running
- **FR strings captured**: yes | no

## Step-by-step trace

### Step 1 — <one-line action description>
- **Action**: <plain English>
- **Element**: text "Continue", role button, no aria-label
- **Selector candidates** (ranked):
  1. `getByRole('button', { name: 'Continue' })`
  2. `getByText('Continue')`
- **EN / FR**: "Continue" / "Continuer"  *(omit FR row if not captured)*
- **Network**: POST /web/v2/auth/email-check → 200

### Step 2 — ...

## Failed requests

- **POST /web/v2/spendings/manual** → 500
  - Backend log: `release reservation: invalid input syntax for type uuid: ""`
  - First seen at: Step 4

## Console issues

- **WARN**: "useAuthorizationChecks: registration state still resolving" at /validations
- **ERROR**: ...

## Roadblocks

- **Step 5** — error toast: "Something went wrong"
  - Screenshot: `/tmp/flow-scout/skipr-EMPLOYEE-create-spending-20260423-143200/step-5-error.png`
  - Probable cause: see "Recommended fixes" #1.

## Recommended fixes

### #1 — Seed pending spending is missing reservation_id

- **Diagnosis**: the DELETE on the pending manual spending crashes because `reservation_id` is empty in the seed. See `frontend/docs/e2e.md` § "Debugging selectors with Chrome DevTools MCP" — known gap.
- **File**: `backend/srv/spending/repository/db/seeds/seeds.go`
- **Diff**:
  ```diff
   {
     ID: "...0001",
     Status: "pending",
  +  ReservationID: uuid.MustParse("…"),
   }
  ```
- **Post-edit ritual**:
  ```bash
  PGPASSWORD=local psql -h 127.0.0.1 -p 8201 -U local -d testing -c \
    "ALTER DATABASE \"tmpl_e2e_master_<hash>\" IS_TEMPLATE false; DROP DATABASE \"tmpl_e2e_master_<hash>\";"
  docker restart "<api-web container>"
  ```
- **Status**: declined — surfaced for developer review.  *OR*  **Status**: applied; flow re-walked successfully on retry (see Step 4 below).

## Open questions

- Does the "Need your attention" badge count include need_more_info spendings without merchant? Couldn't tell from the visible UI alone.
```

### Phase 9 — Hand off

After the report is written, print to chat:

1. Path to the report: `/tmp/flow-scout/skipr-<role>-<flow-slug>-<ts>.md`.
2. The `x-test-id` (so the developer can teardown manually if they decline cleanup now).
3. Ask one question: "Teardown the test DB now (`POST /test/db/teardown`), or leave it so you can keep clicking around with the same test-id?"
   - **Teardown now** → `curl -X POST http://localhost:8084/test/db/teardown -H "X-Test-Id: <uuid>"` (verify the actual teardown contract at runtime).
   - **Leave it** → do nothing. Note in chat that the clone will accumulate until next stack restart or `scripts/e2e-local.sh --teardown`.

Do not prescribe what the developer should do next. The skill ends here.

## Anti-patterns

- **Writing test code.** Never. Not even a skeleton, not even a "here's roughly what the test would look like" snippet. The report contains observations, not test scaffolding.
- **Modifying frontend component code** to add `data-testid` attributes. Flag the candidate location in the report; the developer decides.
- **Forgetting `?x-test-id=<uuid>` on a navigation.** This is the #1 cause of confusing failures in this workflow. Every URL. Every time.
- **Guessing at seed contents instead of querying the live clone DB.** You have `psql` access. Use it before proposing a patch.
- **Auto-applying seed patches without showing the diff first.** Always show, always confirm.
- **Silently deciding the flow is "done".** Always ask the developer.
- **Skipping the screenshot at an error moment.** Routine steps don't get screenshots; error moments always do — the screenshot is what makes the report useful for downstream bug tickets.
- **Reading credentials from anywhere except `playwright.config.ts`.** One source of truth.
- **Running this skill against `backoffice`.** Not supported. Stop and tell the developer.

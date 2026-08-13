---
name: record-web-demo
description: Produce a polished demo video (mp4 by default) of a web-app feature by writing a Playwright demo script in the session scratchpad — using Playwright's built-in screencast API with animated cursor, element highlights, action titles, chapter overlays, and deliberate slow pacing — then rendering with ffmpeg. Nothing is added to the target repo. Use when user says /record-web-demo, "make a demo video", "record a demo of this feature", "screen-record this flow", "show off this feature", or wants a shareable video or gif of a web UI flow even if they don't mention Playwright, recording, or ffmpeg. Always trigger when the user asks for a video of a web-app flow.
---

# Record Web Demo

Write a Playwright demo script in the session scratchpad, run it headless against the user's app, and deliver a polished mp4 — animated cursor, click indicators, action titles, chapter overlays, and deliberate pacing — without adding anything to the target repo.

## Required inputs

Ask the user for these if not already provided:

- **The flow to demo** — as user-visible steps ("open the board, create a task, mark it done").
- **App URL and how to start it** — usually a local dev server; start it if it is not running.
- **Auth** — none, login shown as part of the demo, or un-recorded login before recording starts.
- **Demo name** — becomes the output filename.
- **Where to save the final mp4** — ask every time; also send the file in chat.

Defaults that need no confirmation: 1280x720, mp4 only, headless.

## Process

### 1. Confirm the storyboard

Turn the flow into a short named beat list (chapters + actions). Print it and wait for the user to confirm before writing any code.

### 2. Collect selectors

If the app is running, explore the flow with the chrome-devtools MCP tools (`take_snapshot`, `navigate_page`, `click`) — exploration only, never recording. Otherwise read the app code. Prefer `getByRole`/`getByLabel`/`getByTestId` locators.

### 3. Set up the scratchpad runtime

In `<scratchpad>/record-web-demo/`:

```bash
npm init -y && npm i playwright@latest   # the screencast cursor option needs >= 1.61
npx playwright install chromium          # first use downloads ~130MB, then cached
```

Copy `assets/demo-helpers.mjs` and `assets/demo-template.mjs` (renamed `<name>.demo.mjs`) from this skill into that directory.

### 4. Handle auth

Do login and data seeding before `demo.record()` so they stay out of the video, unless login is itself the feature. For multiple demos in one session, call `demo.saveAuthState()` once and pass `storageState` to later launches. Auth state stays in the scratchpad and dies with the session.

### 5. Write the demo script

Edit `<name>.demo.mjs`: one `chapter()` per major beat, plain locator actions between them — `showActions` animates the pointer to each target, marks the click, highlights the element, and shows the action title automatically. `pause()` between actions, `type()` for input, `finish()` last. Keep the video under ~60 seconds; pass `slow: 1.5` for a more deliberate read.

### 6. Run it

`node <name>.demo.mjs` — the last stdout line is the webm path. On failure, read the `*.failure.png` screenshot saved next to the output, fix, re-run.

### 7. Verify by reading frames

Extract frames and actually look at them:

```bash
ffmpeg -y -i recordings/<name>.webm -vf fps=1 frames/f_%03d.png
```

Read 4-6 frames as images and check: cursor and click dot on action frames, chapter overlays render, every storyboard beat appears, no error states. Re-pace and re-run if it reads badly.

### 8. Render

Run this skill's `scripts/render.sh recordings/<name>.webm` → mp4 (last stdout line is the path). Only produce a gif or keep the raw webm if the user asked for those.

### 9. Deliver

Copy the mp4 to the destination the user chose and send it in chat. Report path, duration, and file size.

## Output

- `<destination>/<name>.mp4` — the delivered video.
- Working files (script, webm, frames) stay in the scratchpad — discardable, nothing in the target repo.

## Done when

- The mp4 exists at the user's chosen destination and was sent in chat.
- Extracted frames were actually read and show the cursor, click indicators, and chapter overlays.
- Every beat from the confirmed storyboard appears in the video.
- The target repo has no new or modified files.

## Anti-patterns

- Hand-rolling cursor overlays, bezier mouse movement, or click ripples — `showActions({cursor: 'pointer'})` renders the animated pointer, click dot, and element highlight natively. Never install ghost-cursor or similar.
- Using the target project's Playwright — it may pin a version below 1.61; always install latest in the scratchpad runtime.
- The `recordVideo` context option — no start/stop control, records setup, and only finalizes on context close. Use `page.screencast` via the helpers.
- Calling `record()` before login and seeding are done — that footage cannot be un-recorded, only trimmed.
- `mouse.move({steps})` or the `slowMo` launch option for pacing — linear as-fast-as-possible interpolation and slowed setup respectively; pace with `pause()` beats, `type()` delays, and the `slow` multiplier.
- Firing the next action immediately after a click — the ~900ms annotation gets cut off; keep a `pause()` between beats.
- Calling `page.screencast.showChapter()` directly — it does not block; use `demo.chapter()`, which waits out the overlay.
- Writing demo files into the target repo — everything lives in the scratchpad; only the mp4 reaches the user's destination.
- Producing a gif by default — mp4 only; gif and raw webm are on request.
- Declaring done without extracting and reading frames.

## References

- **[references/ffmpeg-recipes.md](references/ffmpeg-recipes.md)** — trimming, speeding up one section, zoom-on-click, gif size tuning. Read only when the user wants output beyond the default mp4 (`render.sh` already covers plain gif and uniform speed).

// Demo-video helpers built on Playwright's screencast API (requires playwright >= 1.61).
// Copied into the scratchpad runtime next to the *.demo.mjs scripts that import it.
//
// Between helper calls, drive the page with plain locator actions — showActions
// renders the animated pointer, element highlight, and action title for each one.

import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

export async function launchDemo({
  url,
  out = "recordings/demo.webm",
  size = { width: 1280, height: 720 },
  headless = true,
  storageState,
  slow = 1,
  annotations = {},
} = {}) {
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({ viewport: size, storageState });
  const page = await context.newPage();

  const outPath = path.resolve(out);
  let recording = false;
  const sleep = (ms) => page.waitForTimeout(ms * slow);

  if (url) {
    await page.goto(url);
    await sleep(1000);
  }

  return {
    browser,
    context,
    page,

    // Start recording. Call only after un-recorded setup (login, seeding) is done.
    async record() {
      await fs.mkdir(path.dirname(outPath), { recursive: true });
      await page.screencast.start({ path: outPath, size });
      await page.screencast.showActions({
        cursor: "pointer",
        duration: 900 * slow,
        ...annotations,
      });
      recording = true;
      await sleep(600); // hold the opening frame
    },

    // Centered narration overlay. showChapter does not block, so wait it out.
    async chapter(title, { description, hold = 2400 } = {}) {
      await page.screencast.showChapter(title, {
        description,
        duration: hold * slow,
      });
      await sleep(hold + 300);
    },

    // Narrative beat between actions.
    async pause(ms = 900) {
      await sleep(ms);
    },

    // Click into a field and type with a per-key delay that reads naturally on video.
    async type(locator, text, { delay = 70 } = {}) {
      await locator.click();
      await sleep(400);
      await locator.pressSequentially(text, { delay: delay * slow });
      await sleep(400);
    },

    // Persist login state for other demos in this session (scratchpad-local, ephemeral).
    async saveAuthState(file = "auth-state.json") {
      const statePath = path.resolve(file);
      await context.storageState({ path: statePath });
      return statePath;
    },

    // Hold the final state, stop recording, and print the webm path as the last stdout line.
    async finish() {
      await sleep(1500);
      if (recording) await page.screencast.stop();
      await context.close();
      await browser.close();
      console.log(outPath);
      return outPath;
    },

    // Save a failure screenshot and partial recording for debugging, then rethrow.
    async abort(error) {
      const shot = outPath.replace(/\.webm$/, ".failure.png");
      if (recording) await page.screencast.stop().catch(() => {});
      await page.screenshot({ path: shot }).catch(() => {});
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
      console.error(`demo failed; screenshot: ${shot}`);
      throw error;
    },
  };
}

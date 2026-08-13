// Demo: NAME — one line on what this demo shows.
// Run from the scratchpad runtime: node NAME.demo.mjs
import { launchDemo } from "./demo-helpers.mjs";

const demo = await launchDemo({
  url: "http://localhost:3000",
  out: "recordings/NAME.webm",
  // headless: false,                    // watch live while iterating
  // storageState: 'auth-state.json',    // reuse a login saved earlier this session
  // slow: 1.5,                          // global pacing multiplier
});
const { page } = demo;

try {
  // Un-recorded setup (login, seeding) goes here, before record().
  // await page.getByLabel('Email').fill('user@example.com');
  // await page.getByRole('button', { name: 'Sign in' }).click();
  // await demo.saveAuthState();

  await demo.record();

  await demo.chapter("Feature name", { description: "What this demo shows" });

  // Beat 1 — what happens
  await page.getByRole("button", { name: "New item" }).click();
  await demo.pause();

  // Beat 2 — what happens
  await demo.type(page.getByLabel("Title"), "Hello world");

  await demo.finish();
} catch (err) {
  await demo.abort(err);
}

#!/usr/bin/env node
// Capture a live page with Playwright, anchor the annotations to elements, then
// render. Anchors mean the callouts survive a UI change — rings and arrows follow
// the elements they point at, while note cards stay where you place them.
//
//   node capture.mjs <spec.json> [out.png]
//
// Writes the rendered PNG, an .svg sidecar, a .resolved.json with the measured
// coordinates, and (with --keep-raw) the unannotated screenshot.
import { existsSync, readFileSync, writeFileSync, mkdtempSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { renderSpec } from './render.mjs';

const args = process.argv.slice(2);
const keepRaw = args.includes('--keep-raw');
const keepSvg = !args.includes('--no-svg');
const [specArg, outArg] = args.filter((a) => !a.startsWith('--'));

if (!specArg || specArg === '--help' || specArg === '-h') {
  console.log(`usage: node capture.mjs <spec.json> [out.png] [--keep-raw] [--no-svg]

Captures spec.url with Playwright, resolves each annotation's "anchor" to a
measured rect, and renders the annotated PNG. See SKILL.md for the spec format.`);
  process.exit(specArg ? 0 : 1);
}

const specPath = resolve(specArg);
const specDir = dirname(specPath);
const spec = JSON.parse(readFileSync(specPath, 'utf8'));
if (!spec.url) {
  throw new Error(`${specPath}: no "url" field. For an existing image use annotate.mjs instead.`);
}

const url = process.env.ANNOTATE_URL ?? spec.url;
const scale = spec.scale ?? 2;
const fullPage = spec.fullPage ?? false;
const viewport = spec.viewport ?? { width: 1440, height: 950 };
const outPath =
  outArg ?? resolve(specDir, (spec.name ?? 'shot') + '.annotated.png');

const browser = await launch();

try {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: scale,
    reducedMotion: 'reduce', // stop shimmers mid-frame
    storageState: spec.storageState ? resolve(specDir, spec.storageState) : undefined,
    extraHTTPHeaders: spec.extraHTTPHeaders,
  });
  const page = await context.newPage();

  // domcontentloaded, not networkidle: a dev server keeps HMR sockets open.
  await page.goto(url, { waitUntil: spec.waitUntil ?? 'domcontentloaded', timeout: spec.timeout ?? 30000 });
  await runSetup(page, spec.setup ?? []);
  if (spec.waitForSelector) await page.locator(spec.waitForSelector).first().waitFor({ state: 'visible' });

  const resolved = await resolveAnchors(page, spec, { fullPage });

  const shotDir = mkdtempSync(join(tmpdir(), 'annotate-shot-'));
  const shotPath = join(shotDir, 'raw.png');
  await page.screenshot({
    path: shotPath,
    fullPage,
    animations: 'disabled',
    caret: 'hide',
    mask: spec.mask?.map((m) => page.locator(m)),
    maskColor: spec.maskColor,
  });

  const rawPath = keepRaw ? outPath.replace(/\.png$/i, '') + '.raw.png' : null;
  if (rawPath) copyFileSync(shotPath, rawPath);

  const { warnings, svgPath, width, height } = renderSpec(resolved, readFileSync(shotPath), outPath, { keepSvg });
  const resolvedPath = outPath.replace(/\.png$/i, '') + '.resolved.json';
  writeFileSync(resolvedPath, JSON.stringify(resolved, null, 2) + '\n');

  console.log(`wrote ${outPath} (${width}x${height})`);
  console.log(`  url:      ${url}`);
  console.log(`  resolved: ${resolvedPath}   (re-render without a browser: annotate.mjs)`);
  if (rawPath) console.log(`  raw:      ${rawPath}`);
  if (svgPath) console.log(`  svg:      ${svgPath}`);
  for (const a of resolved.annotations ?? []) {
    if (a.anchor) console.log(`  ${a.type} <- ${a.anchor} ${JSON.stringify(a.rect ?? a.at)}`);
  }
  for (const w of warnings) console.warn(`warn: ${w}`);
} finally {
  await browser.close();
}

// ---------------------------------------------------------------------------

async function launch() {
  const playwright = await loadPlaywright();
  return playwright.chromium.launch();
}

// Playwright has to be resolved from the project being screenshotted, not from this
// skill: a bare import() resolves relative to this file, and pnpm only links the
// package into the projects that declare it. createRequire makes Node resolve as if
// from that directory, which handles pnpm's symlinks and @playwright/test (which
// re-exports chromium).
async function loadPlaywright() {
  const unwrap = async (url) => {
    const mod = await import(url);
    // Importing a CJS entry point can leave everything on `default`.
    return mod.chromium ? mod : (mod.default ?? mod);
  };

  const explicit = process.env.PLAYWRIGHT_MODULE;
  if (explicit) return unwrap(pathToFileURL(resolve(explicit)).href);

  const specs = ['playwright', '@playwright/test'];
  const dirs = [];
  let dir = process.cwd();
  for (;;) {
    dirs.push(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const d of dirs) {
    const req = createRequire(join(d, 'index.js'));
    for (const spec of specs) {
      try {
        const pw = await unwrap(pathToFileURL(req.resolve(spec)).href);
        if (pw?.chromium) return pw;
      } catch {
        // try the next candidate
      }
    }
  }
  throw new Error(
    'playwright not found. Run this from inside the project you are screenshotting, install it:\n' +
      '  npm i -D playwright && npx playwright install chromium\n' +
      'or point at an existing install with PLAYWRIGHT_MODULE=/path/to/node_modules/playwright/index.js',
  );
}

async function runSetup(page, setup) {
  for (const [i, step] of setup.entries()) {
    const at = `setup[${i}] (${step.action})`;
    const loc = step.selector ? page.locator(step.selector).first() : null;
    switch (step.action) {
      case 'waitForSelector':
        await page.locator(step.selector).first().waitFor({ state: step.state ?? 'visible', timeout: step.timeout ?? 15000 });
        break;
      case 'waitForTimeout':
        await page.waitForTimeout(step.ms ?? 500);
        break;
      case 'click':
        await loc.waitFor({ state: 'visible' });
        await loc.click();
        break;
      case 'hover':
        await loc.waitFor({ state: 'visible' });
        await loc.hover();
        break;
      case 'fill':
        await loc.waitFor({ state: 'visible' });
        await loc.fill(step.text ?? '');
        break;
      case 'type':
        await loc.waitFor({ state: 'visible' });
        await loc.pressSequentially(step.text ?? '', { delay: step.delay ?? 20 });
        break;
      case 'press':
        if (loc) await loc.press(step.key);
        else await page.keyboard.press(step.key);
        break;
      case 'scrollIntoView':
        await page.locator(step.selector).first().scrollIntoViewIfNeeded();
        break;
      case 'scroll':
        if (loc) await page.locator(step.selector).first().evaluate((el) => el.scrollIntoView({ block: 'center' }));
        else await page.evaluate(([x, y]) => window.scrollTo(x, y), [step.x ?? 0, step.y ?? 0]);
        break;
      case 'evaluate':
        await page.evaluate(step.script);
        break;
      default:
        throw new Error(`${at}: unknown setup action`);
    }
  }
}

/** Replace every `anchor` / `pointsToAnchor` with measured CSS-pixel geometry. */
async function resolveAnchors(page, spec, { fullPage }) {
  if (!fullPage) await page.evaluate(() => window.scrollTo(0, 0));

  const rectOf = async (selector) => {
    const handle = await page.locator(selector).first().elementHandle();
    if (!handle) throw new Error(`anchor not found: ${selector}`);
    return handle.evaluate((el, fp) => {
      const r = el.getBoundingClientRect();
      // getBoundingClientRect is viewport-relative; full-page shots start at the document top.
      const ox = fp ? window.scrollX : 0;
      const oy = fp ? window.scrollY : 0;
      return { x: r.left + ox, y: r.top + oy, width: r.width, height: r.height };
    }, fullPage);
  };

  const annotations = [];
  for (const [i, a] of (spec.annotations ?? []).entries()) {
    const out = { ...a };
    const label = `${a.type}${a.title ? ` "${a.title}"` : ''} #${i}`;

    if (a.anchor) {
      const r = await rectOf(a.anchor);
      const box = [round(r.x), round(r.y), round(r.width), round(r.height)];
      if (a.type === 'ring' || a.type === 'redact' || a.type === 'blur') out.rect = box;
      else if (a.type === 'badge') out.at = boxCorner(box, a.corner ?? 'tl', a.r ?? 14);
      else throw new Error(`${label}: "anchor" is only supported on ring/redact/blur/badge, not ${a.type}`);
    }

    if (a.pointsToAnchor) {
      const r = await rectOf(a.pointsToAnchor);
      const edge = a.pointsToEdge ?? 'left';
      const t = a.pointsToAt ?? 0.5; // fraction along the edge, so an arrow can meet a tall target off-centre
      const [x, y, w, h] = [r.x, r.y, r.width, r.height];
      const point = {
        left: [x, y + h * t],
        right: [x + w, y + h * t],
        top: [x + w * t, y],
        bottom: [x + w * t, y + h],
        center: [x + w / 2, y + h / 2],
      }[edge];
      if (!point) throw new Error(`${label}: pointsToEdge must be left/right/top/bottom/center`);
      const nudge = a.pointsToOffset ?? [0, 0];
      out.pointsTo = [round(point[0] + nudge[0]), round(point[1] + nudge[1])];
    }

    if (a.type === 'note' && !out.pointsTo) {
      throw new Error(`${label}: a note needs either "pointsTo": [x, y] or "pointsToAnchor": "selector"`);
    }
    annotations.push(out);
  }

  return { ...spec, url: undefined, image: undefined, setup: undefined, annotations };
}

function boxCorner([x, y, w, h], corner, r) {
  const inset = r / 2;
  const map = {
    tl: [x - inset, y - inset],
    tr: [x + w + inset, y - inset],
    bl: [x - inset, y + h + inset],
    br: [x + w + inset, y + h + inset],
  };
  return map[corner] ?? map.tl;
}

function round(n) {
  return Math.round(n * 100) / 100;
}

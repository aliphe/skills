#!/usr/bin/env node
// Compose several annotated screenshots into a comics-style storyboard.
//
//   node storyboard.mjs <spec.json> [out.png] [--svg]
//
// Source panels are the annotated PNGs you already render with
// annotate-screenshot (annotate.mjs / capture.mjs). See SKILL.md for the spec.
import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { renderStory, pngSize } from './render.mjs';

const args = process.argv.slice(2);
const keepSvg = args.includes('--svg');
const [specArg, outArg] = args.filter((a) => !a.startsWith('--'));

if (!specArg || specArg === '--help' || specArg === '-h') {
  console.log(`usage: node storyboard.mjs <spec.json> [out.png] [--svg]

Composes spec.panels into one comic-strip PNG. Panel images are the annotated
PNGs from annotate-screenshot. Output defaults to <spec>.png next to the spec.
--svg keeps an .svg sidecar (off by default: the panels are embedded, so it is large).`);
  process.exit(specArg ? 0 : 1);
}

const specPath = resolve(specArg);
const specDir = dirname(specPath);
const spec = JSON.parse(readFileSync(specPath, 'utf8'));
const panels = spec.panels ?? [];
if (!panels.length) throw new Error(`${specPath}: no "panels"`);

// Load each referenced image once; absolute paths keep the dedupe honest.
const images = new Map();
for (const p of panels) {
  if (!p.image) continue;
  const path = resolve(specDir, p.image);
  if (!images.has(path)) {
    const buf = readFileSync(path);
    images.set(path, { buf, ...pngSize(buf) });
  }
  p.image = path;
}

const outPath =
  outArg ??
  resolve(specDir, (spec.name ?? basename(specPath).replace(/\.spec\.json$|\.json$/, '')) + '.png');

const { warnings, svgPath, width, height, story } = renderStory(spec, images, outPath, { keepSvg });

console.log(`wrote ${outPath} (${width}x${height} layout px)`);
console.log(`  spec: ${specPath}`);
if (story.hasHeader && spec.title) console.log(`  "${spec.title}"`);
for (const p of story.panels) {
  const who = p.kicker ? `${String(p.kicker).toUpperCase()} · ` : '';
  const kind = p.kindStyle.stamp ? ` [${p.kind}]` : '';
  console.log(`  ${p.step ?? '·'} ${who}${p.title ?? '(untitled)'}${kind}`);
}
if (svgPath) console.log(`  svg:  ${svgPath}`);
for (const w of warnings) console.warn(`warn: ${w}`);

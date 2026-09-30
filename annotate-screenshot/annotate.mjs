#!/usr/bin/env node
// Annotate an existing PNG. No browser, no npm install — the spec's coordinates
// are used as-is.
//
//   node annotate.mjs <spec.json> [out.png]
//
// Missing annotations are usually a coordinate problem: render, look at the PNG,
// adjust the rects, render again.
import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { renderSpec } from './render.mjs';

const args = process.argv.slice(2);
const keepSvg = !args.includes('--no-svg');
const [specArg, outArg] = args.filter((a) => !a.startsWith('--'));
if (!specArg || specArg === '--help' || specArg === '-h') {
  console.log(`usage: node annotate.mjs <spec.json> [out.png] [--no-svg]

Annotates an existing PNG from a spec. See SKILL.md for the spec format.
Output defaults to <spec>.png next to the spec, with an <spec>.svg sidecar.
--no-svg skips the sidecar — use it when the output lands in a repo's docs folder.`);
  process.exit(specArg ? 0 : 1);
}

const specPath = resolve(specArg);
const specDir = dirname(specPath);
const spec = JSON.parse(readFileSync(specPath, 'utf8'));
if (!spec.image) {
  throw new Error(`${specPath}: no "image" field. For a live page use capture.mjs instead.`);
}

const imagePath = resolve(specDir, spec.image);
const outPath =
  outArg ?? resolve(specDir, basename(specPath).replace(/\.spec\.json$|\.json$/, '') + '.annotated.png');

const imgBuf = readFileSync(imagePath);
const { warnings, svgPath, width, height } = renderSpec(spec, imgBuf, outPath, { keepSvg });

console.log(`wrote ${outPath} (${width}x${height})`);
console.log(`  spec:  ${specPath}`);
console.log(`  image: ${imagePath}`);
if (svgPath) console.log(`  svg:   ${svgPath}`);
for (const w of warnings) console.warn(`warn: ${w}`);

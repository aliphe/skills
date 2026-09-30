// Render an annotated screenshot: embeds a PNG in an SVG, draws the annotation
// layer, rasterises with rsvg-convert. No npm dependencies.
//
// All coordinates in a spec are CSS pixels of the *unscaled* page. The PNG is
// assumed to be `scale` times larger (2 for a retina capture), so every value is
// multiplied by `scale` on the way into the SVG.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

export const DEFAULT_ACCENT = '#4338ca';

const PAD = 16; // note card inner padding, CSS px
const TITLE = { size: 17, lead: 22 };
const MONO = { size: 13, lead: 30, padX: 10 };
const BODY = { size: 14, lead: 20 };
const KICKER = { size: 12, lead: 17 };

// Rough advance widths, used only to warn about text that overflows its card.
const MONO_CHAR = 0.6;
const SANS_CHAR = 0.52;

const round = (n) => Math.round(n * 100) / 100;
const hex = (c, a) => c + Math.round(a * 255).toString(16).padStart(2, '0');
const escapeXml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) {
    throw new Error('input is not a PNG (only PNG is supported)');
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function noteHeight(note) {
  let h = PAD;
  if (note.kicker) h += KICKER.lead;
  h += TITLE.lead;
  const pills = [note.endpoint, note.endpoint2].filter(Boolean);
  if (pills.length) h += 12 + pills.length * MONO.lead;
  if (note.lines?.length) h += 12 + note.lines.length * BODY.lead;
  return h + PAD;
}

/**
 * Resolve every annotation to concrete geometry and collect authoring warnings.
 * Nothing here knows about scale — coordinates stay in CSS px.
 */
export function layout(spec) {
  const warnings = [];
  const annotations = spec.annotations ?? [];
  const boxes = new Map();
  const holes = [];
  let nextClip = 0;

  for (const [i, a] of annotations.entries()) {
    const label = a.type + (a.title ? ` "${a.title}"` : ` #${i}`);
    if (!a.type) throw new Error(`annotation #${i} has no type`);
    if (!a.accent) continue;
    if (!/^#[0-9a-fA-F]{6}$/.test(a.accent)) {
      throw new Error(`${label}: accent must be a 6-digit hex colour, got "${a.accent}"`);
    }
  }

  for (const [i, a] of annotations.entries()) {
    const label = a.type + (a.title ? ` "${a.title}"` : ` #${i}`);

    if (a.type === 'note') {
      if (!a.rect) throw new Error(`${label}: notes need "rect": [x, y, width]`);
      const [x, y, w] = a.rect;
      const h = noteHeight(a);
      boxes.set(a, [x, y, w, h]);
      const inner = w - PAD * 2 - MONO.padX;
      for (const [k, text] of [['endpoint', a.endpoint], ['endpoint2', a.endpoint2]]) {
        const need = text ? String(text).length * MONO_CHAR * MONO.size : 0;
        if (need > inner) {
          warnings.push(
            `${label}: ${k} is ~${Math.round(need)}px wide, the pill fits ~${Math.round(inner)}px — ` +
              `widen the card or split it across endpoint/endpoint2`,
          );
        }
      }
      for (const line of a.lines ?? []) {
        const need = String(line).length * SANS_CHAR * BODY.size;
        if (need > w - PAD * 2) {
          warnings.push(
            `${label}: body line "${line.slice(0, 40)}…" is ~${Math.round(need)}px wide, ` +
              `the card fits ~${w - PAD * 2}px`,
          );
        }
      }
    }

    if (a.type === 'ring' || a.type === 'blur' || a.type === 'redact') {
      if (!a.rect) throw new Error(`${label}: needs "rect": [x, y, width, height]`);
      if (a.rect.length !== 4) throw new Error(`${label}: rect must be [x, y, width, height]`);
    }

    if (a.type === 'redact') boxes.set(a, a.rect);
    if (a.type === 'redact') a.__clip = `clip-${nextClip++}`;
    if (a.type === 'ring') {
      const [x, y, w, h] = a.rect;
      const p = a.pad ?? 8;
      const padded = [x - p, y - p, w + p * 2, h + p * 2];
      a.__ring = padded; // the ring and its spotlight hole are always the same rect
      holes.push(padded);
    }
  }

  // A note whose arrow lands outside every spotlight hole points into the dark.
  const dimmed = holes.length > 0 && (spec.dim ?? true) !== false;
  if (dimmed) {
    for (const a of annotations) {
      if (a.type !== 'note' || !a.pointsTo) continue;
      const [px, py] = a.pointsTo;
      const inside = holes.some(([x, y, w, h]) => px >= x && px <= x + w && py >= y && py <= y + h);
      if (!inside) {
        warnings.push(
          `note "${a.title}": arrow lands at ${px},${py}, which is not inside any ring hole — ` +
            `the target will be dimmed. Add a ring for it.`,
        );
      }
    }
  }

  return { boxes, holes, warnings };
}

export function buildSvg(spec, imgBuf) {
  const scale = spec.scale ?? 2;
  const { width: W, height: H } = pngSize(imgBuf);
  if (spec.width && Math.abs(spec.width * scale - W) > 2) {
    throw new Error(
      `spec.width ${spec.width} * scale ${scale} = ${spec.width * scale}, but the image is ${W}px wide. ` +
        `Fix "scale" or "width".`,
    );
  }
  const px = (n) => round(n * scale);
  const { boxes, holes, warnings } = layout(spec);
  const annotations = spec.annotations ?? [];
  const accentOf = (a) => a.accent ?? DEFAULT_ACCENT;

  for (const [i, a] of annotations.entries()) {
    const label = a.type + (a.title ? ` "${a.title}"` : ` #${i}`);
    const r = a.type === 'ring' ? a.rect : boxes.get(a);
    if (!r) continue;
    const [x, y, w] = r;
    const h = r[3] ?? 0;
    if (x < 0 || y < 0 || x + w > W / scale + 1 || y + h > H / scale + 1) {
      warnings.push(`${label}: sits outside the image (${W / scale}x${H / scale} CSS px) — it will be clipped`);
    }
  }

  const drawRing = (rect, accent) => {
    const [x, y, w, h] = rect;
    return (
      `<rect x="${px(x)}" y="${px(y)}" width="${px(w)}" height="${px(h)}" rx="${px(10)}" fill="none" ` +
      `stroke="#ffffff" stroke-width="${px(5)}" stroke-opacity="0.9"/>` +
      `<rect x="${px(x)}" y="${px(y)}" width="${px(w)}" height="${px(h)}" rx="${px(10)}" fill="none" ` +
      `stroke="${accent}" stroke-width="${px(2.5)}"/>`
    );
  };

  const drawNote = (note, accent) => {
    const [x, y, w, h] = boxes.get(note);
    const cx = x + PAD;
    let cy = y + PAD;
    const out = [
      `<rect x="${px(x)}" y="${px(y)}" width="${px(w)}" height="${px(h)}" rx="${px(12)}" fill="#ffffff" ` +
        `stroke="${hex('#0f172a', 0.08)}" stroke-width="${px(1)}" filter="url(#card)"/>`,
    ];
    if (note.kicker) {
      out.push(
        `<text x="${px(cx)}" y="${px(cy + 13)}" font-family="Helvetica Neue" font-size="${px(KICKER.size)}" ` +
          `font-weight="700" letter-spacing="${px(0.9)}" fill="${accent}">${escapeXml(note.kicker.toUpperCase())}</text>`,
      );
      cy += KICKER.lead;
    }
    out.push(
      `<text x="${px(cx)}" y="${px(cy + TITLE.size)}" font-family="Helvetica Neue" font-size="${px(TITLE.size)}" ` +
        `font-weight="700" fill="#0f172a">${escapeXml(note.title)}</text>`,
    );
    cy += TITLE.lead;
    for (const pill of [note.endpoint, note.endpoint2].filter(Boolean)) {
      out.push(
        `<rect x="${px(cx)}" y="${px(cy + 6)}" width="${px(w - PAD * 2)}" height="${px(MONO.lead - 8)}" ` +
          `rx="${px(5)}" fill="${hex(accent, 0.09)}"/>` +
          `<text x="${px(cx + MONO.padX)}" y="${px(cy + 21)}" font-family="Menlo" font-size="${px(MONO.size)}" ` +
          `fill="${accent}">${escapeXml(pill)}</text>`,
      );
      cy += MONO.lead;
    }
    if (note.lines?.length) {
      cy += 12;
      for (const line of note.lines) {
        out.push(
          `<text x="${px(cx)}" y="${px(cy + BODY.size)}" font-family="Helvetica Neue" font-size="${px(BODY.size)}" ` +
            `fill="#475569">${escapeXml(line)}</text>`,
        );
        cy += BODY.lead;
      }
    }
    return out.join('\n');
  };

  const drawArrow = (note, accent) => {
    const [x, y, w, h] = boxes.get(note);
    const start = {
      right: [x + w + 8, y + h / 2],
      left: [x - 8, y + h / 2],
      top: [x + w / 2, y - 8],
      bottom: [x + w / 2, y + h + 8],
    }[note.from ?? 'right'];
    const end = note.pointsTo;
    const dx = end[0] - start[0];
    const dy = end[1] - start[1];
    const c1 = [start[0] + dx * 0.45, start[1] + dy * 0.06];
    const c2 = [end[0] - dx * 0.35, end[1] - dy * 0.3];
    const d =
      `M ${px(start[0])} ${px(start[1])} C ${px(c1[0])} ${px(c1[1])}, ` +
      `${px(c2[0])} ${px(c2[1])}, ${px(end[0])} ${px(end[1])}`;
    return (
      `<path d="${d}" fill="none" stroke="#ffffff" stroke-width="${px(7)}" stroke-opacity="0.85" ` +
      `stroke-linecap="round"/>` +
      `<path d="${d}" fill="none" stroke="${accent}" stroke-width="${px(2.5)}" stroke-linecap="round" ` +
      `marker-end="url(#head-${accent.slice(1)})"/>`
    );
  };

  const drawBadge = (a, accent) => {
    const [x, y] = a.at;
    const r = px(a.r ?? 14);
    return (
      `<circle cx="${px(x)}" cy="${px(y)}" r="${r + px(2.5)}" fill="#ffffff" fill-opacity="0.9"/>` +
      `<circle cx="${px(x)}" cy="${px(y)}" r="${r}" fill="${accent}"/>` +
      `<text x="${px(x)}" y="${px(y + (a.r ?? 14) * 0.35)}" text-anchor="middle" font-family="Helvetica Neue" ` +
      `font-size="${px((a.r ?? 14) * 1.05)}" font-weight="700" fill="#ffffff">${escapeXml(a.n)}</text>`
    );
  };

  const dim = (spec.dim ?? false) === false ? '' : dimLayer(spec, holes, W, H, px);

  const layers = [
    dim,
    ...annotations.filter((a) => a.type === 'ring').map((a) => drawRing(a.__ring ?? a.rect, accentOf(a))),
    ...annotations.filter((a) => a.type === 'note').map((a) => drawNote(a, accentOf(a))),
    ...annotations.filter((a) => a.type === 'note' && a.pointsTo).map((a) => drawArrow(a, accentOf(a))),
    ...annotations.filter((a) => a.type === 'badge').map((a) => drawBadge(a, accentOf(a))),
  ];

  const accents = [...new Set(annotations.map(accentOf))];
  const markers = accents
    .map(
      (c) =>
        `<marker id="head-${c.slice(1)}" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="4" markerHeight="4" ` +
        `orient="auto-start-reverse"><path d="M0,0.6 L9.5,5 L0,9.4 z" fill="${c}"/></marker>`,
    )
    .join('\n');

  const holeRects = holes
    .map(
      ([x, y, w, h]) =>
        `<rect x="${px(x)}" y="${px(y)}" width="${px(w)}" height="${px(h)}" rx="${px(10)}" fill="#000"/>`,
    )
    .join('\n');

  const redacts = annotations
    .filter((a) => a.type === 'redact')
    .map((a) => {
      const [x, y, w, h] = a.rect;
      const rect = `<rect x="${px(x)}" y="${px(y)}" width="${px(w)}" height="${px(h)}"`;
      // Solid by default: a blurred secret can be recovered from the pixels, so blur
      // is opt-in and only for de-emphasising something that is not actually sensitive.
      return a.style === 'blur'
        ? `<g clip-path="url(#${a.__clip})">` +
            `<use xlink:href="#src" filter="url(#soften)"/>` +
          `</g>`
        : `${rect} fill="${a.color ?? '#0f172a'}"/>`;
    })
    .join('\n');

  const redactClips = annotations
    .filter((a) => a.type === 'redact' && a.style === 'blur')
    .map((a) => {
      const [x, y, w, h] = a.rect;
      return (
        `<clipPath id="${a.__clip}"><rect x="${px(x)}" y="${px(y)}" width="${px(w)}" height="${px(h)}" ` +
        `rx="${px(a.rx ?? 6)}"/></clipPath>`
      );
    })
    .join('\n');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
<filter id="card" x="-20%" y="-20%" width="140%" height="140%">
  <feDropShadow dx="0" dy="${px(2)}" stdDeviation="${px(6)}" flood-color="#0f172a" flood-opacity="0.18"/>
</filter>
<filter id="soften" x="-10%" y="-10%" width="120%" height="120%">
  <feGaussianBlur stdDeviation="${px(spec.redactBlur ?? 7)}"/>
</filter>
<mask id="holes">
  <rect width="${W}" height="${H}" fill="#fff"/>
  ${holeRects}
</mask>
${redactClips}
${markers}
</defs>
<image id="src" x="0" y="0" width="${W}" height="${H}" xlink:href="data:image/png;base64,${imgBuf.toString('base64')}"/>
${redacts}
${layers.join('\n')}
</svg>`;

  return { svg, warnings, width: W, height: H };
}

function dimLayer(spec, holes, W, H, px) {
  const dim = spec.dim ?? { color: '#0b1020', opacity: 0.34 };
  if (!holes.length) return '';
  return (
    `<rect width="${W}" height="${H}" fill="${dim.color ?? '#0b1020'}" opacity="${dim.opacity ?? 0.34}" ` +
    `mask="url(#holes)"/>`
  );
}

/**
 * Build, rasterise, and (unless told otherwise) write the SVG sidecar. Returns warnings.
 * Without a sidecar the SVG goes to rsvg-convert on stdin, so nothing is left
 * behind next to a doc's images.
 */
export function renderSpec(spec, imgBuf, outPath, { keepSvg = true } = {}) {
  const { svg, warnings, width, height } = buildSvg(spec, imgBuf);
  const svgPath = keepSvg ? outPath.replace(/\.png$/i, '') + '.svg' : null;
  if (svgPath) writeFileSync(svgPath, svg);
  try {
    execFileSync('rsvg-convert', svgPath ? ['-o', outPath, svgPath] : ['-o', outPath], {
      input: svgPath ? undefined : svg,
      stdio: svgPath ? ['ignore', 'ignore', 'pipe'] : ['pipe', 'ignore', 'pipe'],
    });
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error('rsvg-convert not found — install it with: brew install librsvg');
    }
    throw new Error(`rsvg-convert failed: ${err.stderr?.toString().trim() || err.message}`);
  }
  return { warnings, svgPath, width, height };
}

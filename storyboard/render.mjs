// Compose several annotated screenshots into a comics-style storyboard: a grid
// of numbered panels, each with a caption, plus optional speech bubbles and
// error/fix stamps. Renders to one PNG through rsvg-convert, the same way
// annotate-screenshot renders a single annotated shot. No npm dependencies.
//
// All coordinates in a spec are CSS pixels of the unscaled page, matching the
// annotate-screenshot format: "scale" (default 2) says how much bigger the
// source PNGs are than their layout size. Crops and bubble anchors are written
// in that same layout space.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const INNER = 16; // horizontal padding inside a panel frame
const PAD = 14; // vertical padding inside a panel frame
const KICKER = { size: 11.5, lead: 16 };
const TITLE = { size: 17, lead: 24 };
const CAPTION = { size: 13.5, lead: 20 };
const BODY = { size: 19, lead: 27 };
const BUBBLE = { size: 13.5, lead: 18, padX: 12, padY: 10 };
const STAMP = { size: 10.5 };
const BADGE_R = 15;
const SANS = 'Helvetica Neue, Helvetica, Arial, sans-serif';
const MONO = 'Menlo, monospace';
const CHAR = 0.52; // rough advance width, as a fraction of the font size

export const THEME = {
  paper: '#f4f1ea',
  frame: '#ffffff',
  ink: '#111827',
  muted: '#4b5563',
  accent: '#4338ca',
  error: '#b91c1c',
  fix: '#15803d',
};

const round = (n) => Math.round(n * 100) / 100;
const hex = (c, a) => c + Math.round(a * 255).toString(16).padStart(2, '0');
const escapeXml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const textWidth = (s, size, factor = CHAR) => String(s).length * size * factor;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

export function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) {
    throw new Error('input is not a PNG (only PNG is supported)');
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** Greedy word wrap by estimated pixel width. Explicit "\n" forces a break. */
export function wrapText(text, maxWidth, size, factor = CHAR) {
  const lines = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && textWidth(candidate, size, factor) > maxWidth) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    lines.push(line);
  }
  return lines;
}

function kindStyles(kind, theme, accentOverride) {
  switch (kind) {
    case 'error':
      return { accent: accentOverride ?? theme.error, stroke: theme.error, stamp: '✗ what goes wrong' };
    case 'fix':
      return { accent: accentOverride ?? theme.fix, stroke: theme.fix, stamp: '✓ the fix' };
    case 'note':
      return { accent: accentOverride ?? theme.accent, stroke: theme.accent, stamp: null };
    default:
      return { accent: accentOverride ?? theme.accent, stroke: theme.ink, stamp: null };
  }
}

/**
 * Resolve the spec into concrete geometry. Nothing here knows about density —
 * every value stays in layout px. `images` maps an absolute path to {width,height}.
 */
export function layoutStory(spec, images) {
  const warnings = [];
  const theme = { ...THEME, ...(spec.theme ?? {}) };
  const scale = spec.scale ?? 2;
  const pageW = spec.width ?? 1600;
  const padX = spec.padding ?? 48;
  const gutter = spec.gutter ?? 26;
  const columns = Math.max(1, spec.columns ?? 2);
  const aspect = spec.panelAspect ?? 1.6;
  const steps = spec.steps !== false;

  const panels = spec.panels ?? [];
  if (!panels.length) throw new Error('spec has no panels');
  if (spec.columns && panels.length % columns !== 0) {
    warnings.push(`${panels.length} panels in rows of ${columns} leave a gap in the last row`);
  }

  const panelW = (pageW - 2 * padX - (columns - 1) * gutter) / columns;
  const contentW = panelW - 2 * INNER;
  const contentH = contentW / aspect;
  const captionW = contentW - 14; // leaves room for the narration bar

  for (const [i, p] of panels.entries()) {
    const label = `panel ${p.step ?? i + 1}${p.title ? ` "${p.title}"` : ''}`;
    p.__lines = p.caption ? wrapText(p.caption, captionW, CAPTION.size) : [];
    p.__lines.forEach((line) => {
      if (textWidth(line, CAPTION.size) > captionW + 1) {
        warnings.push(`${label}: caption line "${line.slice(0, 32)}…" may overflow the panel`);
      }
    });
    if (p.__lines.length > (spec.maxCaptionLines ?? 4)) {
      warnings.push(`${label}: caption is ${p.__lines.length} lines, keep it under ${spec.maxCaptionLines ?? 4}`);
    }
    if (!p.image && !p.body) {
      warnings.push(`${label}: text panel has no "image" and no "body"`);
    }
  }

  const anyKicker = panels.some((p) => p.kicker);
  const anyTitle = panels.some((p) => p.title);
  const maxLines = Math.min(
    spec.maxCaptionLines ?? 4,
    Math.max(0, ...panels.map((p) => p.__lines.length)),
  );

  const headerStrip = PAD + (anyKicker ? KICKER.lead : 0) + (anyTitle ? TITLE.lead : 0) + 10;
  const captionStrip = maxLines ? 12 + maxLines * CAPTION.lead + PAD : PAD;
  const panelH = headerStrip + contentH + captionStrip;

  // Page header (title card).
  let hy = padX;
  const titleBaseline = spec.title ? hy + 30 : null;
  if (spec.title) hy += 38;
  const subtitleBaseline = spec.subtitle ? hy + 18 : null;
  if (spec.subtitle) hy += 26;
  const hasHeader = Boolean(spec.title || spec.subtitle);
  const ruleY = hasHeader ? hy + 8 : null;
  const panelsTop = hasHeader ? ruleY + 22 : padX;

  const footerH = spec.footer ? 34 : 0;
  const rows = Math.ceil(panels.length / columns);
  const pageH = panelsTop + rows * panelH + (rows - 1) * gutter + (spec.footer ? footerH + padX : padX);

  const laid = panels.map((p, i) => {
    const kind = kindStyles(p.kind, theme, p.accent);
    const col = i % columns;
    const row = Math.floor(i / columns);
    const frameX = padX + col * (panelW + gutter);
    const frameY = panelsTop + row * (panelH + gutter);
    const contentX = frameX + INNER;
    const contentY = frameY + headerStrip;

    const panel = {
      ...p,
      kindStyle: kind,
      step: steps ? p.step ?? i + 1 : null,
      frame: [frameX, frameY, panelW, panelH],
      content: [contentX, contentY, contentW, contentH],
    };

    const img = p.image ? images.get(p.image) : null;
    if (p.image && !img) {
      throw new Error(`panel ${panel.step}: image not loaded: ${p.image}`);
    }
    if (img) {
      const imgW = img.width / scale;
      const imgH = img.height / scale;
      const crop = p.crop ?? [0, 0, imgW, imgH];
      if (crop[0] < 0 || crop[1] < 0 || crop[0] + crop[2] > imgW + 1 || crop[1] + crop[3] > imgH + 1) {
        warnings.push(
          `panel ${panel.step}: crop [${crop}] falls outside the image (${round(imgW)}x${round(imgH)} layout px)`,
        );
      }
      const cropAspect = crop[2] / crop[3];
      if (Math.abs(cropAspect - aspect) / aspect > 0.2) {
        const kept = cropAspect > aspect ? aspect / cropAspect : cropAspect / aspect;
        warnings.push(
          `panel ${panel.step}: crop aspect ${round(cropAspect)} vs panel ${round(aspect)} — ` +
            `about ${Math.round((1 - kept) * 100)}% of the crop will be cut. Adjust the crop or "panelAspect".`,
        );
      }
      // cover: fill the content box, centred on the crop
      const s = Math.max(contentW / crop[2], contentH / crop[3]);
      const offX = (contentW - crop[2] * s) / 2;
      const offY = (contentH - crop[3] * s) / 2;
      panel.paint = {
        x: contentX - crop[0] * s + offX,
        y: contentY - crop[1] * s + offY,
        w: imgW * s,
        h: imgH * s,
        s,
        crop,
        offX,
        offY,
      };
      panel.toScreen = (pt) => [
        contentX + (pt[0] - crop[0]) * s + offX,
        contentY + (pt[1] - crop[1]) * s + offY,
      ];

      if (p.bubble) {
        panel.bubble = layoutBubble(p.bubble, panel, theme, warnings);
      }
    }
    return panel;
  });

  return {
    theme,
    pageW,
    pageH,
    padX,
    gutter,
    panelW,
    panelH,
    contentW,
    contentH,
    columns,
    rows,
    hasHeader,
    titleBaseline,
    subtitleBaseline,
    ruleY,
    panelsTop,
    footerH,
    panels: laid,
    warnings,
  };
}

function layoutBubble(bubble, panel, theme, warnings) {
  const [contentX, contentY, contentW, contentH] = panel.content;
  const [sx, sy] = panel.toScreen(bubble.at);
  const maxW = Math.min(bubble.maxWidth ?? 300, contentW * 0.62);
  const lines = wrapText(bubble.text, maxW - 2 * BUBBLE.padX, BUBBLE.size);
  const w = Math.max(...lines.map((l) => textWidth(l, BUBBLE.size))) + 2 * BUBBLE.padX;
  const h = lines.length * BUBBLE.lead + 2 * BUBBLE.padY;
  const place = bubble.place ?? 'top';
  const gap = 22;
  let x;
  let y;
  if (place === 'top') {
    x = sx - w / 2;
    y = sy - gap - h;
  } else if (place === 'bottom') {
    x = sx - w / 2;
    y = sy + gap;
  } else if (place === 'left') {
    x = sx - gap - w;
    y = sy - h / 2;
  } else {
    x = sx + gap;
    y = sy - h / 2;
  }
  x = clamp(x, contentX + 4, contentX + contentW - w - 4);
  y = clamp(y, contentY + 4, contentY + contentH - h - 4);

  const outside = sx < contentX || sx > contentX + contentW || sy < contentY || sy > contentY + contentH;
  if (outside) {
    warnings.push(
      `panel ${panel.step}: bubble anchor ${round(sx)},${round(sy)} is outside the panel — check the crop`,
    );
  }
  const accent = bubble.accent ?? theme.error;
  return { x, y, w, h, lines, place, sx, sy, accent };
}

export function buildSvg(spec, images, story) {
  const density = spec.density ?? 2;
  const { theme } = story;

  const header = [];
  if (spec.title) {
    header.push(
      `<text x="${story.padX}" y="${story.titleBaseline}" font-family="${SANS}" font-size="30" ` +
        `font-weight="700" fill="${theme.ink}">${escapeXml(spec.title)}</text>`,
    );
  }
  if (spec.subtitle) {
    header.push(
      `<text x="${story.padX}" y="${story.subtitleBaseline}" font-family="${SANS}" font-size="15" ` +
        `fill="${theme.muted}">${escapeXml(spec.subtitle)}</text>`,
    );
  }
  if (story.ruleY != null) {
    header.push(
      `<line x1="${story.padX}" y1="${story.ruleY}" x2="${story.pageW - story.padX}" y2="${story.ruleY}" ` +
        `stroke="${hex(theme.ink, 0.14)}" stroke-width="1.5"/>`,
    );
  }
  if (spec.footer) {
    header.push(
      `<text x="${story.pageW / 2}" y="${story.pageH - story.padX + 6}" text-anchor="middle" ` +
        `font-family="${SANS}" font-size="12.5" fill="${hex(theme.muted, 0.85)}">${escapeXml(spec.footer)}</text>`,
    );
  }

  const body = story.panels.map((p, i) => drawPanel(p, story, images, i)).join('\n');

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
    `width="${round(story.pageW * density)}" height="${round(story.pageH * density)}" ` +
    `viewBox="0 0 ${story.pageW} ${story.pageH}">\n` +
    `<defs>\n` +
    `<filter id="panel" x="-10%" y="-10%" width="120%" height="120%">` +
    `<feDropShadow dx="0" dy="3" stdDeviation="6" flood-color="#0f172a" flood-opacity="0.16"/></filter>\n` +
    `<filter id="bubble" x="-20%" y="-20%" width="140%" height="140%">` +
    `<feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="#0f172a" flood-opacity="0.25"/></filter>\n` +
    `<clipPath id="paper"><rect width="${story.pageW}" height="${story.pageH}"/></clipPath>\n` +
    `</defs>\n` +
    `<rect width="${story.pageW}" height="${story.pageH}" fill="${theme.paper}"/>\n` +
    `${header.join('\n')}\n${body}\n</svg>\n`;

  return { svg, warnings: story.warnings, width: story.pageW, height: story.pageH };
}

function drawPanel(p, story, images, index) {
  const { theme } = story;
  const [fx, fy, fw, fh] = p.frame;
  const [cx, cy, cw, ch] = p.content;
  const accent = p.kindStyle.accent;
  const out = [];

  // frame
  out.push(
    `<rect x="${fx}" y="${fy}" width="${fw}" height="${fh}" rx="8" fill="${theme.frame}" ` +
      `stroke="${p.kindStyle.stroke}" stroke-width="${p.kindStyle.stamp ? 3 : 2.5}" filter="url(#panel)"/>`,
  );

  // content box
  if (!p.image) {
    out.push(`<rect x="${cx}" y="${cy}" width="${cw}" height="${ch}" rx="6" fill="${hex(accent, 0.05)}"/>`);
    out.push(
      `<rect x="${cx}" y="${cy}" width="${cw}" height="3" fill="${accent}"/>`,
    );
    const lines = wrapText(p.body ?? p.title ?? '', cw - 56, BODY.size);
    const blockH = lines.length * BODY.lead;
    let by = cy + (ch - blockH) / 2 + BODY.size;
    for (const line of lines) {
      out.push(
        `<text x="${cx + cw / 2}" y="${by}" text-anchor="middle" font-family="${SANS}" ` +
          `font-size="${BODY.size}" font-weight="700" fill="${theme.ink}">${escapeXml(line)}</text>`,
      );
      by += BODY.lead;
    }
  } else {
    const img = images.get(p.image);
    const clipId = `content-${index}`;
    out.push(`<clipPath id="${clipId}"><rect x="${cx}" y="${cy}" width="${cw}" height="${ch}" rx="6"/></clipPath>`);
    if (img && p.paint) {
      out.push(
        `<image x="${round(p.paint.x)}" y="${round(p.paint.y)}" width="${round(p.paint.w)}" ` +
          `height="${round(p.paint.h)}" clip-path="url(#${clipId})" ` +
          `xlink:href="data:image/png;base64,${img.buf.toString('base64')}"/>`,
      );
    }
    out.push(
      `<rect x="${cx}" y="${cy}" width="${cw}" height="${ch}" rx="6" fill="none" ` +
        `stroke="${hex(theme.ink, 0.12)}" stroke-width="1"/>`,
    );
  }

  // header: step badge, kicker, title
  if (p.step != null) {
    const bx = fx + 24;
    const by = fy + 24;
    out.push(
      `<circle cx="${bx}" cy="${by}" r="${BADGE_R}" fill="${p.kindStyle.stamp ? accent : theme.ink}"/>` +
        `<text x="${bx}" y="${by + 5}" text-anchor="middle" font-family="${SANS}" font-size="14" ` +
        `font-weight="700" fill="#ffffff">${escapeXml(p.step)}</text>`,
    );
  }
  const textX = fx + (p.step != null ? 48 : INNER);
  let ty = fy + PAD;
  if (p.kicker) {
    out.push(
      `<text x="${textX}" y="${ty + 12}" font-family="${SANS}" font-size="${KICKER.size}" font-weight="700" ` +
        `letter-spacing="1" fill="${accent}">${escapeXml(String(p.kicker).toUpperCase())}</text>`,
    );
    ty += KICKER.lead;
  }
  if (p.title) {
    out.push(
      `<text x="${textX}" y="${ty + TITLE.size}" font-family="${SANS}" font-size="${TITLE.size}" ` +
        `font-weight="700" fill="${theme.ink}">${escapeXml(p.title)}</text>`,
    );
  }

  // caption
  if (p.__lines.length) {
    const capTop = cy + ch + 12;
    out.push(`<rect x="${cx}" y="${capTop}" width="3" height="${p.__lines.length * CAPTION.lead - 5}" rx="1.5" fill="${accent}"/>`);
    let ly = capTop;
    for (const line of p.__lines) {
      out.push(
        `<text x="${cx + 14}" y="${ly + CAPTION.size}" font-family="${SANS}" font-size="${CAPTION.size}" ` +
          `fill="${theme.muted}">${escapeXml(line)}</text>`,
      );
      ly += CAPTION.lead;
    }
  }

  // speech bubble
  if (p.bubble) out.push(drawBubble(p.bubble));

  // stamp
  if (p.kindStyle.stamp) {
    const label = String(p.stamp ?? p.kindStyle.stamp).toUpperCase();
    const tw = textWidth(label, STAMP.size, 0.62) + 22;
    const th = 24;
    const sx = fx + fw - tw - 14;
    const sy = fy - th / 2;
    out.push(
      `<rect x="${sx}" y="${sy}" width="${tw}" height="${th}" rx="12" fill="${accent}"/>` +
        `<text x="${sx + tw / 2}" y="${sy + th / 2 + 4}" text-anchor="middle" font-family="${SANS}" ` +
        `font-size="${STAMP.size}" font-weight="700" letter-spacing="0.8" fill="#ffffff">${escapeXml(label)}</text>`,
    );
  }

  return out.join('\n');
}

function drawBubble(b) {
  const { x, y, w, h, lines, place, sx, sy, accent } = b;
  const tail = 14;
  const pts = {
    top: `${sx - 9},${y + h - 1} ${sx + 9},${y + h - 1} ${sx},${sy - 3}`,
    bottom: `${sx - 9},${y + 1} ${sx + 9},${y + 1} ${sx},${sy + 3}`,
    left: `${x + w - 1},${sy - 9} ${x + w - 1},${sy + 9} ${sx - 3},${sy}`,
    right: `${x + 1},${sy - 9} ${x + 1},${sy + 9} ${sx + 3},${sy}`,
  }[place];
  const out = [
    `<polygon points="${pts}" fill="#ffffff" stroke="${accent}" stroke-width="2" stroke-linejoin="round"/>`,
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${tail - 2}" fill="#ffffff" ` +
      `stroke="${accent}" stroke-width="2" filter="url(#bubble)"/>`,
  ];
  let ly = y + BUBBLE.padY;
  for (const line of lines) {
    out.push(
      `<text x="${x + BUBBLE.padX}" y="${ly + BUBBLE.size}" font-family="${SANS}" font-size="${BUBBLE.size}" ` +
        `fill="#111827">${escapeXml(line)}</text>`,
    );
    ly += BUBBLE.lead;
  }
  return out.join('\n');
}

/** Build, rasterise, and (unless told otherwise) write the SVG sidecar. */
export function renderStory(spec, images, outPath, { keepSvg = false } = {}) {
  const story = layoutStory(spec, images);
  const { svg, warnings, width, height } = buildSvg(spec, images, story);
  const svgPath = keepSvg ? outPath.replace(/\.png$/i, '') + '.svg' : null;
  if (svgPath) writeFileSync(svgPath, svg);
  try {
    execFileSync('rsvg-convert', svgPath ? ['-o', outPath, svgPath] : ['-o', outPath], {
      input: svgPath ? undefined : svg,
      stdio: svgPath ? ['ignore', 'ignore', 'pipe'] : ['pipe', 'ignore', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error('rsvg-convert not found — install it with: brew install librsvg');
    }
    throw new Error(`rsvg-convert failed: ${err.stderr?.toString().trim() || err.message}`);
  }
  return { warnings, svgPath, width, height, story };
}

---
name: annotate-screenshot
description: Annotate a screenshot with rings, arrows and text callouts that name what the UI is doing — the endpoint a button calls, how a list is fetched, which field is wrong. Renders a PNG from a JSON spec, either over an existing image or by capturing a live page and anchoring the callouts to elements by selector. Use when asked to annotate a screenshot, add arrows or callouts to an image, point at a button or field, highlight part of a screen, produce a screenshot for a refinement doc, PR or bug report that explains the code path behind the UI, or redact PII before sharing a screenshot.
---

# Annotate Screenshot

Turns a screenshot into a diagram: a spotlight on the elements that matter, note
cards in the empty gutter, and arrows joining them. Built for docs that have to
explain the machinery behind a screen — "this button calls `PUT …`, these
statements come from `GET …`" — without a human opening Figma.

Two engines, same spec format:

| | Source | Anchors | Use when |
|---|---|---|---|
| `annotate.mjs` | an existing PNG | `rect` coordinates | you already have the screenshot, or you want to re-render without a browser |
| `capture.mjs` | a live page via Playwright | `anchor` selectors | the UI still moves — callouts follow the elements |

## Requirements

- `rsvg-convert` for rasterising — `brew install librsvg`
- `capture.mjs` additionally needs Playwright, resolved from the project you are
  screenshotting (see [Playwright resolution](#playwright-resolution))

## Quick start

```bash
# annotate an image you already have
node annotate.mjs spec.json out.png

# capture a live page, anchoring callouts to elements
cd /path/to/project && node /path/to/capture.mjs spec.json out.png
```

Both write the PNG plus an `.svg` sidecar with the vector text, and print
warnings for anything that overflows or lands outside the image. Pass `--no-svg`
when the output goes into a repo's docs folder and you do not want a 500 KB
sidecar next to it. `capture.mjs` also writes a `.resolved.json` with measured
coordinates — that file re-renders through `annotate.mjs` with no browser and no
server.

## The loop

1. **Decide the source.** Live page if it can move, existing PNG if not.
2. **Read the image first.** You cannot place a callout without seeing the
   layout. Find the gutters — usually the pale illustration column on the left,
   or a margin — and plan the cards there.
3. **Write the spec**, then render.
4. **Read the rendered PNG back.** Always. Coordinates are a guess until you look
   at the pixels; the first render is normally 1–2 adjustments away.
5. **Check the warnings**, fix, re-render.

## Coordinates

Spec coordinates are **CSS pixels of the unscaled page**, and `scale` (default 2)
multiplies them on the way into the SVG. A 2880×1900 retina screenshot is
`scale: 2` of a 1440×950 page, so measure against the 1440-wide layout and write
those numbers.

For engine B you measure off the image yourself. For engine A you write selectors
and never think about pixels:

```jsonc
{ "type": "ring", "anchor": "role=button[name=/Accept the mobility policy/i]", "pad": 10 }
```

## Spec

```jsonc
{
  "name": "esign-onboarding-statement",
  "image": "docs/esign/screenshots/statement.png",  // engine B; relative to the spec
  "url": "http://localhost:5200/onboarding/statement", // engine A; ANNOTATE_URL overrides
  "scale": 2,
  "viewport": { "width": 1440, "height": 950 },       // engine A
  "fullPage": false,
  "dim": { "color": "#0b1020", "opacity": 0.34 },     // omit or false for no spotlight
  "annotations": [ /* see below */ ]
}
```

### Primitives

| `type` | Fields | Effect |
|---|---|---|
| `ring` | `rect` or `anchor`, `pad` (8), `accent` | Halo + ring around the target, and a **hole punched in the spotlight** so the target stays lit |
| `note` | `rect: [x, y, width]`, `title`, `kicker`, `endpoint`, `endpoint2`, `lines: []`, `accent`, `from`, `pointsTo` / `pointsToAnchor` | White card, auto height, with a leader arrow |
| `badge` | `n`, `at` or `anchor`, `corner` (`tl`/`tr`/`bl`/`br`), `r` (14) | Numbered circle, for steps referenced from the prose |
| `redact` | `rect` or `anchor`, `style`, `color`, `rx` | Solid bar by default; `"style": "blur"` for de-emphasising |

`note` text: `kicker` is the small uppercase label above the title, `endpoint` /
`endpoint2` render as monospace pills (split a long endpoint across the two
rather than overflowing the card), and `lines` are the plain body lines — one
array entry per line, wrapped by you.

### Arrows

A `note` needs a target. Either a literal point, or an anchored one:

```jsonc
{ "type": "note", "rect": [150, 770, 470], "pointsTo": [737, 839] }
{ "type": "note", "rect": [30, 700, 470], "pointsToAnchor": "css=.card", "pointsToEdge": "left", "pointsToAt": 0.18 }
```

`pointsToEdge` is `left` / `right` / `top` / `bottom` / `center`, `pointsToAt` is
the fraction along that edge (default `0.5`), and `pointsToOffset: [dx, dy]`
nudges the landing point. `from` picks the card edge the arrow leaves (default
`right`) — set it so the arrow does not cross its own card.

Point a tall target off-centre. An arrow from a card at `y=337` to the midpoint
of a 490px-tall card at `y=516` is a 180px vertical line that reads as a border,
not a callout.

### Colours

`accent` is per annotation and defaults to indigo `#4338ca`. Two colours carry
meaning cheaply: one for reads, one for writes.

| | | |
|---|---|---|
| `#0369a1` | blue | reads, `GET` |
| `#c2410c` | orange | writes, `PUT` / `POST` |
| `#4338ca` | indigo | neutral, or a single-accent diagram |

## Anchoring

`ring`, `redact` and `badge` take `anchor`; `note` takes `pointsToAnchor`. The
selector is Playwright's engine syntax — `css=.card`,
`role=button[name=/Accept/i]`, `text=Filters`, `#id`. Prefer `role=`/`text=`: a
class is a styling detail, a role and accessible name are what the user sees.

Measured coordinates land in the `.resolved.json`. When the UI shifts, re-run
`capture.mjs`; the rings and arrows follow, and the cards stay where you put
them. That split is deliberate — **arrows and rings are semantics, card
positions are layout.** Cards are placed by hand because only you can see which
gutter is empty.

### Setup actions

Drive the page to the state you want to photograph:

```jsonc
"setup": [
  { "action": "click", "selector": "role=button[name=/Sign in/]" },
  { "action": "fill", "selector": "#email", "text": "benoit+orgbe+e2e+ci@skipr.co" },
  { "action": "press", "key": "Enter" },
  { "action": "waitForSelector", "selector": "css=.card" },
  { "action": "scrollIntoView", "selector": "css=.card" }
]
```

Also: `hover`, `type`, `scroll`, `waitForTimeout`, `evaluate`. `storageState`,
`extraHTTPHeaders`, `waitUntil` and `timeout` are top-level keys. On a dev server
keep `waitUntil: "domcontentloaded"` — `networkidle` never fires while HMR holds
a socket open.

## Redaction

Screenshots for a ticket or a doc leak data. `redact` with `anchor` is the
reliable way — it follows the element instead of relying on your eye:

```jsonc
{ "type": "redact", "anchor": "text=benoit+orgbe+e2e+ci@skipr.co", "style": "blur" }
```

**Solid is the default and blur is opt-in, on purpose.** A blurred secret is
still in the pixels; blur de-emphasises, it does not redact. Use `style: "blur"`
only for something that is merely distracting.

`capture.mjs` also forwards Playwright's own `mask: ["selector"]` (and
`maskColor`) to the screenshot, which is cheaper when there are many hits.

## Playwright resolution

`capture.mjs` resolves Playwright from **the directory you run it in**, walking
upwards, trying `playwright` then `@playwright/test`. Run it from inside the
project, or point at an install explicitly:

```bash
PLAYWRIGHT_MODULE=/path/to/node_modules/playwright/index.js node capture.mjs spec.json out.png
```

A bare import would fail: ESM resolves relative to the script, and with pnpm the
package is only linked into projects that declare it.

## Design rules

- **Two or three callouts per screenshot.** More than that and the screenshot is
  doing a document's job.
- **Put cards in a gutter, not on the subject.** Overlapping the thing you are
  explaining defeats the annotation. The spotlight dim buys you freedom: a card
  over pale decorative artwork reads fine.
- **Say the mechanism, not the click.** `PUT /web/v2/memberships/{id}/sign_sworn_statements`
  beats "click here" when the reader is an engineer reading a refinement doc.
- **Warn about what the screenshot cannot show** in `lines` — "recomputed on
  every `GET /registration`, nothing is stored" is the kind of fact a picture
  alone will not convey.
- **Reuse one accent per concern** so the reader learns the code once.

## Pitfalls

- **Skipping the read-back.** The single most common failure is shipping a render
  nobody looked at. Read the PNG.
- **A card wider than its gutter.** The overflow warnings catch text; a card
  itself is not checked. Keep `rect[2]` inside the space you actually have.
- **`endpoint` overflowing.** The pill is one line. The warning gives you the
  pixel deficit — split across `endpoint`/`endpoint2`.
- **Arrows into the dark.** If a target has no `ring`, its spotlight hole does
  not exist and the arrow points into a dimmed area. The renderer warns.
- **`scale` mismatched to the image.** A 1x screenshot needs `"scale": 1`, or
  every coordinate lands at double the intended position.
- **Forgetting the arrows' white casing.** Arrows are drawn with a white
  underlay; if you hand-edit the SVG, keep it, or the line disappears into a busy
  background.

## Worked example

`examples/esign-onboarding-statement.spec.json` annotates the employee
onboarding statement screen: the statement list arrives from
`GET …/sworn_statements?only_unsigned&only_required`, and
`Accept the mobility policy` calls `PUT …/sign_sworn_statements`.

```bash
node annotate.mjs examples/esign-onboarding-statement.spec.json /tmp/statement.annotated.png
```

## Checklist

- [ ] Rendered PNG read back and looked at
- [ ] No warnings, or each one deliberately accepted
- [ ] Rings on every arrow target
- [ ] Cards in a gutter, not over the subject
- [ ] Accent colours consistent with read/write meaning
- [ ] PII redacted before the image leaves the machine

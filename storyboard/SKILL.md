---
name: storyboard
description: Compose several annotated screenshots into one comics-style storyboard — a grid of numbered panels, each with a caption, plus optional speech bubbles and "what goes wrong" / "the fix" stamps. Renders a single PNG. Use when several screenshots have to be read as one sequence: a user journey, a before/after, a flow that goes wrong, an erroneous scenario, a bug walkthrough, or a refinement-doc story. Panel images are the annotated PNGs from the annotate-screenshot skill.
---

# Storyboard

A folder of annotated screenshots still makes the reader assemble the story
themselves. Storyboard does the assembling: it lays the annotated shots out as
comic panels, in reading order, with the narration written under each one.

It does not capture or annotate. That is [annotate-screenshot](../annotate-screenshot/SKILL.md)'s
job — its `annotate.mjs` / `capture.mjs` produce the annotated PNGs, and each of
those becomes one panel here. The split is deliberate: a picture explains the
mechanism, a caption explains why it matters.

| | |
|---|---|
| `storyboard.mjs` | composes panels into one PNG via rsvg-convert |
| input | annotated PNGs + a story spec (JSON) |
| output | one PNG, `<spec>.png`, plus an optional `.svg` sidecar (`--svg`) |

## Requirements

- `rsvg-convert` for rasterising — `brew install librsvg`
- annotated PNGs, produced by the annotate-screenshot skill

## Quick start

```bash
node storyboard.mjs story.spec.json out.png
```

Renders the PNG, prints the reading order and any warnings. Read the output back
before you use it: the first render is usually one crop adjustment away.

## The workflow

1. **Break the story into 4–8 beats, one panel each.** A beat is a decision or a
   state change, not a click. "HR hits Save" is a beat; "the dialog opens" is a
   beat; "the cursor moves" is not.
2. **Annotate one screenshot per beat** with annotate-screenshot. Do the
   annotation there, not here: rings, note cards and arrows are its language, and
   the numbers you measure (`rect`) are the same ones you will crop with.
3. **Write the spec**, one panel per beat, in order.
4. **Crop each panel to its beat.** The whole screenshot is rarely the shot you
   want — annotate-screenshot shoots full pages, a comic panel is a frame.
5. **Render, read the PNG back, adjust.** Crops are guesses until you look.
6. **Fix the warnings** — the renderer flags cuts, overflows and off-panel anchors.

## Spec

```jsonc
{
  "name": "hr-authoring-storyboard",
  "title": "HR publishes a sworn statement",
  "subtitle": "Electronic Signature · M1 — the gap between saving and publishing",
  "footer": "Panels annotated with the annotate-screenshot skill",
  "scale": 2,          // source PNGs are `scale`× their layout size (as in annotate specs)
  "width": 1600,       // layout width of the whole strip
  "density": 2,        // raster scale — 2 gives a retina PNG
  "columns": 2,
  "panelAspect": 1.6,  // every panel keeps this width/height ratio
  "panels": [ /* see below */ ]
}
```

### Panel

| Field | Meaning |
|---|---|
| `image` | annotated PNG, path relative to the spec |
| `crop` | `[x, y, w, h]` in the source's **layout px** — what the panel shows |
| `kicker` | who is acting: `HR`, `Employee`, `api-web` |
| `title` | the beat, in a few words |
| `caption` | the narration, one or two sentences — the point, not the click |
| `kind` | `scene` (default) · `note` · `error` · `fix` |
| `body` | text panels only (no `image`): the large centered line |
| `bubble` | `{ text, at: [x, y], place, maxWidth, accent }` — a speech bubble |
| `stamp` | override the stamp label on `error` / `fix` |
| `accent` | override the panel colour |
| `step` | panel number, defaults to its position |

`error` turns the frame red and stamps it **what goes wrong**; `fix` does the same
in green. Use them for the scenario you are warning about and the change that
answers it. A panel with no `image` is a text panel — an intertitle — and still
carries a `kind`, so a red intertitle is a valid "what goes wrong" card.

Panels are laid out left to right, `columns` per row, all the same size. Keep the
count to a multiple of `columns` or the last row is short (the renderer warns).

### Crops

`crop` and `bubble.at` are in the **same layout pixels as the annotate spec's
`rect`** — the numbers you measured when you placed a ring are the numbers that
frame the shot. `scale: 2` means the PNG is twice that size, so a 2880×3800
screenshot is 1440×1900 layout px.

The crop is scaled to **fill** the panel (CSS `object-fit: cover`), centred, so:

- Match the crop's aspect to `panelAspect`, or the renderer warns that a chunk
  will be cut. `w / h ≈ panelAspect` is the whole rule.
- A crop narrower than the panel zooms in — that is how you make a close-up of
  one control. A crop of the full width zooms out.
- Cropping into a gutter cuts the note card that lives there. Take the whole
  notice with the region it explains, or none of it.

### Bubbles

A bubble gives a panel a voice: "I'll just dismiss this." It anchors to a point in
the source image and places itself around it.

```jsonc
{ "type": "bubble", "text": "I'll just dismiss this.", "at": [498, 1053], "place": "bottom", "accent": "#b91c1c" }
```

`at` is in the same layout px as `crop`, so anchoring to a button means reading
its `rect` from the annotate spec. `place` is `top` / `bottom` / `left` /
`right` — which side of the anchor the bubble body sits on. It is clamped inside
the panel; if the anchor itself falls outside the crop, the renderer warns.

Bubbles are seasoning. One per story, usually on the error panel, and never over
the control it is pointing at.

## Design rules

- **Caption the meaning, not the action.** "Save sends `PUT /programs/{id}`,
  which upserts the row and makes every signature stale" beats "HR clicks Save".
  The panel already shows the click.
- **One beat per panel.** If a caption needs "and then", it is two panels.
- **Two or three callouts per screenshot, and no more** — the same limit
  annotate-screenshot enforces, because the panel is smaller than the page.
- **Uniform panels, uneven content.** Crops carry the rhythm: a wide establishing
  shot, then a close-up of the one control that matters.
- **Red is a claim.** `error` says this is the thing that goes wrong. Use it once
  or twice, not on every panel that is merely unhappy.
- **End on the fix.** A story that stops at the bug is a bug report; the last
  panel should be what changes.

## Pitfalls

- **Cropping away the annotation.** The note cards sit in the margins; a tight
  crop that centres the subject often removes the note that explains it. Widen
  the crop or annotate a version framed for the story.
- **Aspect drift.** Every crop not close to `panelAspect` silently loses its
  edges. The warning says how much. Fix the crop, not the warning.
- **`scale` mismatched to the source.** A 2880-wide PNG is `scale: 2` of a
  1440 page. The wrong value doubles or halves every crop and anchor.
- **A bubble over its own target.** Keep the anchor's point visible next to the
  bubble, not underneath it.
- **Captions that outgrow the panel.** Four lines is the limit; a longer caption
  is a second panel asking to exist.
- **Committing the SVG sidecar.** Panels are embedded in it, so it runs to
  megabytes. `--svg` is a debugging aid; the PNG is the deliverable.

## Worked example

`docs/esign/screenshots/hr-authoring-storyboard.spec.json` in the monorepo tells
the HR half of the e-signature refinement: HR rewrites the statement, saves it,
the publish dialog opens, HR dismisses it, and the text stays saved with nothing
published — then the employee is served it, and finally the target state.

```bash
cd /Users/matthias/.herdr/worktrees/monorepo/esign/docs/esign/screenshots
node ~/.agents/skills/storyboard/storyboard.mjs hr-authoring-storyboard.spec.json
```

The panels come from three annotated screenshots — two HR screens and the
employee onboarding statement — cropped so each beat gets its own frame.

## Checklist

- [ ] 4–8 panels, one beat each, reading left to right
- [ ] Every panel's crop shows the control *and* the annotation that explains it
- [ ] Crops close to `panelAspect`
- [ ] Captions say the mechanism, not the click
- [ ] `error` / `fix` panels carry the story's turn
- [ ] Rendered PNG read back and looked at
- [ ] No warnings, or each one deliberately accepted

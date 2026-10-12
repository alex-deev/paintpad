# PaintPad

A modern take on MS Paint — browser-based, no old look and feel.

## Getting started

```bash
npm install
npm run dev          # http://localhost:5173
```

## Testing

```bash
npm run test:all     # typecheck + unit + e2e
```

The e2e suite needs Chromium's shared libraries. The devcontainer runs as an unprivileged
user with no sudo, so `playwright install-deps` cannot fetch them — install them locally
first:

```bash
npm run browser:deps   # one-time; extracts Chromium's .so files into .playwright-deps/
npm run test:e2e
```

Without this, `npm run test:e2e` fails with a confusing `libnspr4.so: cannot open shared
object file` error rather than telling you what to do.

Individual suites:

```bash
npm run test           # unit, with enforced 100% coverage thresholds
npm run test:e2e
npm run test:e2e:update # regenerate screenshot goldens — inspect them before committing
```

## Using the editor

| | |
|---|---|
| Tools | `1` pencil · `2` eraser · `3` line · `4` rectangle · `5` ellipse · `6` bucket |
| Size | `[` / `]`, or the slider |
| Colours | Palette, native picker, or a hex value. Click a swatch to target it, `X` or ⇄ to swap |
| Undo / redo | `Ctrl+Z` · `Ctrl+Shift+Z` or `Ctrl+Y` |
| Zoom | Wheel, or `+` / `−` · `1:1` · `Fit` |
| Pan | Space-drag, or middle-drag |
| Constrain | Hold `Shift` — 45° lines, square rectangles, circular ellipses |
| Transparency | `∅` clears the canvas background |
| Bucket scope | The toggle beside the tools — `Contiguous` fills the connected region, `Global` every matching pixel |

The canvas opens **transparent**. Set a background from the second swatch and the eraser
restores it; leave it unset and erasing produces real transparency, which PNG export
preserves.

`Export` downloads a PNG at the document's own resolution (2560×1440 by default, since
strokes are rasterised at 2×) — independent of your current zoom and display scaling.

## How it works

The canvas is **always derived from a command log**. Drawing, replay, and undo all go
through the same `renderRecord` path, so a committed pixel and a replayed pixel are the same
pixel. `History` is a pure reducer over `{entries, cursor}`; the base canvas is a cache, not
the source of truth.

Autosave persists that log, so the document returns by replaying the same path live drawing
took — there is no separate restore format. The redo stack survives too: reload part-way
through an undo and you can still redo.

Consequences worth knowing:

- **Backgrounds are composited, not baked.** `base` holds artwork only. An erased region
  contains no pixels at all, so changing the background repaints it — baking the background
  in would freeze erased areas at whatever colour they were erased against.
- **Fills store parameters, not pixels.** A fill record holds `{seed, colour, contiguous}`
  and replay re-runs it, so history stays JSON-serialisable. The scanline fill in
  `floodfill.ts` is iterative rather than recursive and 4-connected: recursion overflows the
  stack on a large flat region, and 8-connectivity lets a fill escape through a diagonal
  corner in a border.
- **`devicePixelRatio` affects display only.** The backing store is always logical size × a
  fixed raster scale, so exported files are identical regardless of the monitor.
- **Determinism is scoped.** Replay is byte-exact within a session and across reloads on
  the *same browser build*. Not across browsers or versions — the platform rasteriser
  differs across GPU and CPU paths.

Specs for each slice live in `SPEC-*.md`, recording the decisions taken and the alternatives
rejected.

## Known limitations

- **Fills reach the wall of a freehand line.** Freehand strokes are antialiased, so the edge
  between the fill and the line is a ramp of partial-alpha pixels, and an exact colour match
  stops short of it. The fill absorbs that ramp, recolouring each pixel by its own coverage,
  so the outline keeps its weight and the edge stays antialiased.
- **Screenshot goldens cannot verify alpha.** Playwright's image comparison treats fully
  transparent pixels as "don't care". The goldens verify strokes; transparency is asserted
  directly on the alpha channel in `e2e/transparency.spec.ts`.
- **No image import.** An opened PNG must enter history, and it must enter as `ImageData`,
  which `JSON.stringify` silently destroys. Autosave is now in place, so the remaining
  question is how an image is encoded into the log.
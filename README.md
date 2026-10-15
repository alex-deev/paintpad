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
| Tools | Bottom toolbar. `1` pencil · `2` eraser · `3` line · `4` rectangle · `5` ellipse · `6` bucket · `7` select |
| Size | `[` / `]`, or the slider |
| Colours | Palette, native picker, or a hex value. Click a swatch to target it, `X` or ⇄ to swap |
| Undo / redo | `Ctrl+Z` · `Ctrl+Shift+Z` or `Ctrl+Y` |
| Zoom | Wheel, or `+` / `−` · `1:1` · `Fit` |
| Pan | Space-drag, or middle-drag |
| Constrain | Hold `Shift` — 45° lines, square rectangles, circular ellipses |
| Transparency | `∅` clears the canvas background |
| Bucket scope | The toggle beside the tools — `Contiguous` fills the connected region, `Global` every matching pixel |
| Selection | `7`, then drag a box. Drag **inside** it to move, outside to start a new one. `Delete` erases the contents |
| Clipboard | `Ctrl+C` copy · `Ctrl+X` cut · `Ctrl+V` paste (the paste is selected, so you can move it) |
| Selection size | Shown in the toolbar while a selection exists, in document pixels |
| Selection highlight | The canvas dims outside the selection while one is active, so the selected region reads at full contrast. It is a view layer: it never reaches the artwork, a record, an export, or an autosave |

The canvas opens **transparent**. Set a background from the second swatch and the eraser
restores it; leave it unset and erasing produces real transparency, which PNG export
preserves.

`Export` opens a size chooser offering three tiers — smaller file, balanced, and full
resolution — as fractions of the document's own size, so a 1280×720 document at 2× raster
offers 640×360, 1280×720 and 2560×1440. No tier exceeds the document's true raster size;
a larger PNG is not more detail. Pick one and confirm to download. Set
`VITE_EXPORT_TIERS=false` to restore one-click export at full resolution. Output is
independent of your current zoom and display scaling.

## Responsive layout

The three bars — document actions, colour, tools — each become a **single scrolling row**
below 900px wide. That is the whole trick, and it is worth more than it sounds: before it,
both bottom bars wrapped into three rows on a phone, and `.palette` was a fixed 13-column grid
that could not shrink, so it forced a wrap regardless.

| | chrome before | after | canvas (390x844) |
|---|---|---|---|
| Phone portrait | 42% | **18%** | 487px → **692px** |
| Phone landscape | 47% | **33%** | 206px → **262px** |
| Tablet | 22% | **15%** | — |

Landscape gets a looser budget because the viewport is only 390px tall; 33% there still leaves
a usable canvas, and the point is that none of these regress toward leaving the canvas the
minority of the screen. `e2e/responsive.spec.ts` pins those budgets, plus the no-page-overflow
and one-row-per-bar invariants.

Also handled: larger touch targets on narrow screens (42px tools, 22px chips), a
`max-height: 480px` compaction for landscape phones that drops the shortcut badges and shrinks
the swatch cards to a single line, and `env(safe-area-inset-*)` padding so notched phones keep
chrome clear of the notch and home indicator.

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

- **Selection supports move, delete, copy, cut and paste.** A move carries its
  region as a PNG data URL in the command log, so it costs the same whether it is the first
  move or the fiftieth. An earlier design re-derived the region from the records that produced
  it; that was exact but duplicated exponentially, and ten moves of one stroke grew the save to
  1.3 MB. The clipboard is session state, so it does not survive a reload.
- **The clipboard is internal only.** Paste works inside PaintPad; it does not yet exchange
  images with other applications or the system clipboard.
- **Toolbar changes used to break drawing.** The tool bar was a single unwrapped row, so
  adding controls could push it past the viewport, widen the stage beyond the screen and drag
  the canvas off the left edge — every draw test then failed because its start point was no
  longer over the canvas. It wraps now, is capped at the viewport width, and the tools are
  icons, which is what stopped it overflowing in the first place. Several tests depend on
  fit-to-stage geometry and pin 1:1 where absolute pixel positions matter; the DPR test allows
  a pixel of rounding on view scaling, because the document assertion beside it must stay exact.
- **An occasional e2e failure reading "canvas.surface not found" is not yet root-caused.** It
  appears roughly once every few full-suite runs, always at ~2 s, never in isolation, and is
  accompanied by a blank page rather than a hidden element. A Vite dev-server module-load
  failure has been observed directly in this setup and is the leading suspect. Failures of this
  shape should not be treated as renderer regressions without checking for page errors first.
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

## License

AGPL-3.0 — see [`LICENSE`](LICENSE) for the full text, or
<https://www.gnu.org/licenses/agpl-3.0.html>.

Because this is a browser app, §13 is the part that matters in practice: if you fork it and
run your own hosted copy, you have to offer your users the corresponding source. Deploying
PaintPad unmodified is fine.
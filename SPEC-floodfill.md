# Spec: Flood Fill (Slice 8)

## Objective

Add a bucket tool that fills a contiguous region, or globally, with the drawing colour.

**User story:** As a user, I can click inside a shape I drew and fill it.

**Why now:** The last standalone drawing tool. It was deferred past transparency and export
because fill semantics against an alpha channel are a genuinely different problem, and those
two needed settling first.

## Semantics on an RGBA Document

Fill operates on the **artwork raster** (`base`), which holds artwork only — the background
is composited beneath it at render time. This produces exactly the behaviour expected:

- **Clicking empty canvas** — artwork there is `(0,0,0,0)`, so the fill replaces the empty
  region. With a background set, filling the "background area" repaints it. Matches Paint.
- **Clicking a stroke** — the fill replaces that stroke's colour within the connected region.
- **After erasing** — erased regions are empty artwork and therefore fillable.

## Locked Decisions

| # | Decision | Rejected alternative |
|---|----------|---------------------|
| 1 | **Scanline fill with an explicit stack**, never recursion | Recursive flood fill stack-overflows on a large flat region — which is the *common* case, not an edge case |
| 2 | **4-connectivity** | 8-connectivity lets a fill squeeze through a diagonal corner in a border and escape across the canvas |
| 3 | The record stores **parameters** `{seed, colour, contiguous}` | Storing the changed `ImageData` — `JSON.stringify` silently destroys `ImageData`, which would make autosave wipe documents |
| 4 | **No raster checkpoints.** Replay re-runs the fill | Caching the filled region — stale the moment history branches |
| 5 | Tolerance is a **tested parameter, default 0**, not exposed in the UI | Exposing a slider — a tuning surface that leaks through thin lines, and Paint's exact match is predictable |
| 6 | Fill happens on **pointer-up**, not pointer-down | Filling on press breaks the "canvas is derived from history" invariant, because the base raster would be mutated before its record was committed |
| 7 | `putImageData` writes only the **dirty rect** | Writing the whole 15 MB buffer on every fill |
| 8 | Contiguous **and** global are both shipped | Global alone — it is the default that surprises people |

## Core Design

`src/canvas/floodfill.ts` is pure: it takes a `Uint8ClampedArray`, width, and height. No
`ImageData`, no canvas — so it runs under `environment: "node"` like every other pure module.
The engine wraps it with `getImageData`/`putImageData`.

Matching compares **all four channels including alpha**. Without that, opaque black
`(0,0,0,255)` would match transparent `(0,0,0,0)` and every fill would leak.

## The Antialiased Fringe — Solved by Penumbra Absorption

### Correction to the original analysis

An earlier draft of this spec claimed "the boundary ring of a shape is blended pixels" and
blamed shapes generally. **Measurement contradicts that.** Filling a rectangle or ellipse
leaves **zero** partial-alpha pixels touching the fill — Canvas stroke edges land on pixel
boundaries along straight runs, and the only partial alpha is on the *outside* of corner
miters, where it is not visible against the fill.

Filling a **freehand pencil loop** leaves **902** partial-alpha pixels adjacent to the fill,
forming a continuous ramp (`a=22, 25, 28, 31 … 57`, all pure black). That is the antialiased
edge of the stroke sitting between the fill and the solid line, and it is the hairline users
actually see. Freehand is how people enclose an area, so this is the common case.

Tolerance does not help: a fringe pixel with `a=22` is 22 away from its transparent target,
and so is every genuinely different colour.

### The fix

Absorb the penumbra — the connected run of partial-alpha pixels touching the fill — and
recolour each one toward the fill colour **by its own coverage**:

```
result = strokeRGB · (a/255) + fillRGB · ((255-a)/255),  alpha := 255
```

At full opacity, because both neighbours are now opaque: `a=22` becomes bright pink, `a=253`
becomes near-black. The outline keeps its full visual weight and the edge stays antialiased.

| Option | Rejected because |
|---|---|
| Force every fringe pixel to the solid fill colour | Crispest, but eats ~1px of the outline — a 1px line visibly thins |
| Raise the tolerance | Useless here; see above |
| Accept the hairline | Freehand loops are how areas get enclosed, so this is the common path |
| Absorb one pixel layer | Shallow-angle edges produce a many-pixel ramp; the line would survive, faintly |

### Locked decisions

| # | Decision | Reason |
|---|----------|--------|
| 1 | Absorption runs inside `floodFill`, not as an engine post-pass | The record stores parameters and replay re-runs the fill, so the effect must be deterministic and re-derived |
| 2 | Blend in **sRGB**, unweighted | ImageData is non-premultiplied; linear-light blending would darken mid-coverage pixels relative to the browser's own AA |
| 3 | Output alpha is **255**, not the original `a` | Both neighbours are opaque, so a translucent result would be a visible seam against both |
| 4 | The penumbra is explored through partial-alpha pixels only, stopping at opaque ones | Self-limiting by construction: it cannot leak into transparent canvas or across a solid line |
| 5 | One mask, three states (`0` untouched, `1` filled, `2` absorbed) | Avoids a second raster-sized allocation per fill |
| 6 | Global mode absorbs too | The penumbra exists wherever a fill meets an antialiased edge; restricting it to contiguous mode would make the same drawing fill two different ways |

The `3`-state mask costs one raster-sized byte array per fill, replacing what would otherwise
be a separate mask plus a second one for absorption. It is transient — allocated inside
`floodFill` and released on return.

## Implementation

1. **`floodfill.ts`** (pure) — `floodFill(data, width, height, seed, replacement, options)`
   returning `{changed, bounds}`.
2. **`record.ts`** — `FillRecord`, and `applyRecord()` dispatching to `applyFill()` for fills
   while strokes and shapes keep using `renderRecord()`. The engine calls `applyRecord`.
3. **`applyFill()`** — `getImageData`, run the fill, `putImageData` on the dirty rect only.
4. **Engine** — `fill` tool: capture the seed on pointer-down, compute and commit on
   pointer-up via the normal commit path, so undo needs no special case.
5. **UI** — bucket tool on `6`, plus a Contiguous/Global toggle.

## Testing Strategy

**Unit (`floodfill.ts`, 100% coverage, node):**
- Fills a solid region and reports correct bounds
- **Does not leak through a diagonal gap** — the specific scanline failure mode
- A 4-connected ring fills only the interior
- Seed outside the buffer is a no-op
- Filling with the colour already present is a no-op (prevents degenerate loops)
- **Alpha participates in matching** — opaque black does not match transparent
- Contiguous and global differ on disconnected regions
- Tolerance widens the match
- **Filling a 2000×2000 region completes without exhausting the stack** — the regression
  that recursive fill would fail

**E2E:**
- Fill inside a filled rectangle
- Fill inside an ellipse (the fringe case — asserted on *containment*, not edge pixels)
- Undo restores the pre-fill pixels byte-identically
- Contiguous vs global on the same drawing
- Fill uses the colour selected at fill time and is baked into the record
- With a background set, clicking the background fills that area
- Erased regions are fillable
- Fill does not disturb other regions

## Boundaries

**Always**
- Write back only the dirty rect
- Include alpha in the colour match
- Commit through the normal path so undo works unchanged

**Ask first**
- Exposing tolerance in the UI
- An eyedropper-sampled seed ("fill with the colour I picked")
- Anti-fringe post-processing
- Filling gradients or patterns

**Never**
- Recurse per pixel
- Fill from the view canvas
- Store the filled pixels in the record

## Success Criteria

1. Bucket fills the clicked region with the current colour
2. No diagonal leaks; no stack overflow on large regions
3. Undo/redo work on fills with no special-casing
4. Contiguous and global both behave correctly
5. The fill colour is baked into the record
6. `npm run test:all` green with no regressions

## Open Questions

None. Tolerance's absence from the UI is the one deliberate omission, recorded above.
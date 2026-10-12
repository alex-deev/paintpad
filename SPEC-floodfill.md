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

## The Antialiased Fringe — Accepted, Not Solved

Strokes are antialiased, so the boundary ring of a shape is *blended* pixels rather than the
interior colour. An exact-match fill stops at that ring, leaving a hairline halo. That is
Paint's behaviour and it is predictable.

Tolerance does **not** fix it: a half-alpha edge pixel and a transparent pixel differ by far
more than any useful tolerance. Properly removing a fringe needs a post-pass that re-colours
edge pixels adjacent to the filled region — a different feature, deliberately not here.

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
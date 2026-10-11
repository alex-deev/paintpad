# Spec: Render Engine (Slice 1)

## Objective

Build the drawing engine for PaintPad — a modern MS Paint in the browser. This slice
delivers a **crisp, seam-free, HiDPI-correct stroke renderer** with pan/zoom, committed
through an explicit commit boundary, verified by screenshot goldens.

**User story:** As a user, I can draw pencil and eraser strokes on a canvas that look
correct on any display, at any zoom, and never change appearance between drawing and
re-rendering.

**Why now:** An adversarial review of the original plan found eight fatal defects, seven of
them in the rendering engine (double-composited stroke joints, un-flushed stroke tails, CSS
compositor blend divergence, transform-relative `clearRect`, missing pointer invariants).
Every later slice — undo, shapes, selection, text — is built on this engine. Fixing these
after they are load-bearing is a rewrite; fixing them now is one-liners.

## Assumptions (stated, not silent)

1. Browser app, modern evergreen browsers only (Pointer Events, IndexedDB available).
2. **Smooth AA fidelity bar**, not pixel-art. Pencil = minimum AA width. The user's brief
   says "without the old look and feel"; the aliased path can be added later behind the
   same `strokeToOps` interface.
3. **Opaque white canvas.** The eraser paints the background color via `source-over`, NOT
   `destination-out`. Rationale: `destination-out` against a transparent overlay punches
   nothing, and it contradicts the agreed "no transparency UI" scope. Reversible in slice 2.
4. Undo/redo is **out of scope** for this slice, but the `StrokeRecord` and `commit()`
   boundary exist from day one so slice 2 does not rework the engine.
5. Cursor input only (mouse/trackpad). Pen and touch are future work; Pointer Events are
   used anyway so that migration is additive.
6. No backend, no accounts, no network. Everything runs client-side.

## Tech Stack

- Vite 6 + React 19 + TypeScript 5.7 (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`)
- Canvas 2D — no scene-graph library (Konva/Fabric rejected; their object model fights
  pixel-precise painting)
- Vitest 3 (`environment: node`) for pure logic
- Playwright for screenshot goldens and DOM-level interaction
- No Tailwind in this slice — the harness is deliberately unstyled

## Commands

```
Dev:       npm run dev                # vite on :5173
Build:     npm run build              # tsc -b && vite build
Typecheck: npm run typecheck
Test:      npm run test               # vitest run (unit, node env)
E2E:       npm run test:e2e           # playwright (needs a built or running dev server)
Goldens:   npm run test:e2e:update    # regenerate screenshot baselines
All:       npm run test:all
```

## Project Structure

```
src/
  canvas/
    document.ts   DocModel — logical size, fixed raster scale, versioned header
    viewport.ts   PURE — zoom clamp, screen<->raster transforms, zoom-at-cursor
    stroke.ts     PURE — points[] -> DrawOp[] (smoothing, tail flush, tap-dot)
    record.ts     StrokeRecord type + renderRecord() — self-contained ctx state
    engine.ts     Owns canvases, gesture lifecycle, render loop, commit()
  App.tsx         Minimal dev harness (canvas + readout + key handling)
  main.tsx
tests/
  unit/           node env, zero DOM — stroke, viewport, document
e2e/              Playwright — goldens + interaction
docs/             ADR-style decision records
```

## Code Style

Pure geometry emits **data**, not platform objects. `stroke.ts` never touches `Path2D`
(it does not exist in Node); a thin adapter converts ops to a `Path2D` at draw time. This
is what makes the renderer unit-testable under `environment: "node"`.

```ts
// Good — pure, testable in Node, no DOM.
export function strokeToOps(points: Pt[], width: number): DrawOp[] {
  const w = clampStrokeWidth(width);
  const pts = dedupe(points);
  if (pts.length === 0) return [];
  if (pts.length === 1) return [{ op: "dot", x: pts[0]!.x, y: pts[0]!.y, r: w / 2 }];
  const ops: DrawOp[] = [{ op: "moveTo", x: pts[0]!.x, y: pts[0]!.y }];
  for (let i = 1; i < pts.length - 1; i++) {
    const c = pts[i]!, n = pts[i + 1]!;
    ops.push({ op: "quadTo", cx: c.x, cy: c.y, x: (c.x + n.x) / 2, y: (c.y + n.y) / 2 });
  }
  const last = pts[pts.length - 1]!;
  ops.push({ op: "lineTo", x: last.x, y: last.y });
  return ops;
}
```

Conventions: `camelCase` functions, `PascalCase` types, explicit return types on exported
functions, non-null assertions only where `noUncheckedIndexedAccess` provably allows it.

## Locked Decisions (from adversarial review — do not relitigate without evidence)

| # | Decision | Rejected alternative |
|---|----------|----------------------|
| 1 | Doc = `{v, logicalWidth, logicalHeight, rasterScale}`. Backing store = logical × rasterScale. **DPR and zoom affect display only.** | Backing store × DPR (silently invalidates committed strokes on monitor change) |
| 2 | Rebuild path from the full point list, **one `stroke()` per frame** | Per-segment incremental `stroke()` (double-composites at round-cap joints → beading, even when opaque) |
| 3 | Composite base + overlay **in canvas** per frame | CSS `z-index` stacking (compositor blends in its own layer space; diverges on `display-p3`) |
| 4 | `setTransform(identity)` before every `clearRect` | Assuming a clean transform (clears the wrong region at zoom ≠ 1 → ghost pixels) |
| 5 | Explicit `flushTail()` + tap-dot `arc()` | Midpoint bezier alone (drops the final half-segment; taps draw nothing) |
| 6 | Single `activePointerId`; second pointer ignored | Unconditional `pointerdown` handling (corrupts in-progress stroke) |
| 7 | `pointermove` filtered on `event.buttons !== 0` | Unguarded move handler (hover draws marks) |
| 8 | `composite` field present in `StrokeRecord` from day one | Omit it (slice 2 eraser/alpha then requires a record-type change) |
| 9 | Default canvas 1280×720, area capped at 4096×4096 | Unbounded (Safari caps at 16.7M px; iOS throws `InvalidStateError`) |
| 10 | Engine holds no canvas; `attach()`/`detach()` on the host element | Canvas created in an effect (React 19 StrictMode double-invokes → leaks) |
| 11 | React 19 ref callbacks use the returned-cleanup form | `ref={el => (this.canvas = el)}` (deprecated; now a TS error) |
| 12 | **Stroke width is in LOGICAL px**, converted to raster units at draw time | Storing width in raster units (a "1px" brush becomes 0.5px on screen and vanishes) |
| 13 | Canvas **fits the stage on attach** (never magnifying past 1:1) | Open at 100% (the stage clips with `overflow: hidden`, so an oversized canvas is hit-test truncated while `getBoundingClientRect()` still reports its full box — input near its top lands on the page behind) |
| 14 | Render is **coalesced to one `requestAnimationFrame`**, dirty-flagged | Redrawing per `pointermove` (redundant work at >60Hz input rates) |

## Testing Strategy

**Three levels.** The boundary rule: *if a module imports no DOM API, it is a unit test;
if it touches a canvas, it is an e2e test.* Vitest's jsdom does not implement Canvas 2D, so
no canvas module is ever routed through it.

**Unit (`environment: "node"`, zero DOM)** — `stroke.ts`, `viewport.ts`, `document.ts`:
- Degenerate strokes: 0 points → empty; 1 point → single dot; 2 points → straight line
- Smoothing: midpoint quadratics present; no NaN from duplicate adjacent points
- Width clamping: `0` → `1`; negatives clamped; sub-pixel floor documented
- Viewport: screen↔raster round-trip at zoom 0.25/1/4; zoom clamp; zoom-at-cursor holds the
  document point under the anchor fixed
- Doc validation: area cap rejects 4096×4097; rejects non-finite and non-positive dims

**Golden (Playwright)** — snapshot the **canvas bitmap** (`canvas.toDataURL()`), not a page
screenshot. An element screenshot of a clipped canvas captures whatever page chrome overlaps
its bounding box, and it entangles the rasterizer with page layout and `devicePixelRatio`.
Snapshotting the bitmap isolates exactly what we want to regress on.
The canaries for the fatal defects:
- 1px diagonal at 45° — catches joint beading
- Fast flick (2 input samples) — catches missing tail flush
- Single tap — catches missing dot
- Width sweep 1 / 2 / 8 / 64 — catches sub-pixel and clamping regressions
- Zoom 25% / 100% / 400% — catches `clearRect`/transform bugs and DPR scaling
- `deviceScaleFactor` 1 / 2 / 3 — catches HiDPI regressions

**Invariant (unit + e2e):** the live renderer's ops must equal the ops emitted when replaying
the same points. Both call `strokeToOps` — identity is structural, and a test locks it in.
This is what makes slice 2's undo correct.

Coverage expectation: all pure modules at 100% line and branch. Enforced via
`@vitest/coverage-v8` thresholds in `vite.config.ts` — `npm run test` fails below 100%.
Scope note: `engine.ts`, `record.ts` and `main.tsx` need a real canvas and are gated by the
Playwright goldens instead, so they are deliberately outside the node coverage number.

## Boundaries

**Always**
- Run `npm run typecheck && npm run test` before committing
- Write a test before the behaviour it covers (TDD red-green-refactor)
- Keep `stroke.ts`, `viewport.ts`, `document.ts` free of DOM references
- Pin `colorSpace` explicitly on every 2D context

**Ask first**
- Adding any runtime dependency
- Changing `DocModel` fields (invalidates persisted documents)
- Raising the 4096×4096 area cap
- Any change to `strokeToOps` output shape (breaks stored records in slice 2)

**Never**
- Apply a transform without restoring it (`save()`/`restore()` discipline)
- `clearRect` without an identity transform
- Commit `node_modules`, goldens without review, or secrets
- Remove or weaken a failing test to make a build green

## Success Criteria

Specific and testable. Slice 1 is done when **all** hold:

1. `npm run typecheck` passes with `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`
2. `npm run test` passes with 100% line/branch/function/statement coverage on the pure modules
3. `npm run test:e2e` passes with every golden committed and visually inspected
4. A hand-drawn diagonal shows **no** beads at any of widths 1/2/8/64
5. A 2-sample flick renders a **complete** stroke — no missing tail
6. A single tap renders a **visible** dot
7. Drawing at `deviceScaleFactor` 1, 2, and 3 produces byte-identical document pixels
8. Zoom to 25% / 400% and back leaves **no** ghost pixels on the canvas
9. Hovers over the canvas draw nothing
10. A second concurrent pointer cannot corrupt an in-progress stroke
11. The canvas sits fully inside its stage after attach, so pointer coordinates stay honest

## Open Questions

None outstanding.

## Resolved Questions

- **Coverage tooling** — resolved: `@vitest/coverage-v8` with 100% lines/branches/functions/
  statements enforced on the pure modules (`document.ts`, `stroke.ts`, `viewport.ts`). Canvas
  modules are covered by Playwright goldens instead and sit outside the node coverage number.
- **Raster scale default** — kept at `2`. On a 3× display zoomed past 200% output is soft.
  Deterministic and documented; revisit only if it matters in practice.
- **Word list** — resolved: `cspell.json` with canvas vocabulary and ignore paths for
  generated output.

## Known Limitations (accepted for slice 1)

- **`records` grows unbounded.** *Resolved in slice 2:* history (`{entries, cursor}`) is now
  the source of truth, and entries are retained for redo, so the memory profile is the
  retained entries rather than snapshots. Growth is still unbounded in principle, but a
  naive cap remains wrong: eviction would break replay-from-blank. Revisit only alongside
  fill/paste records, which are the genuinely expensive ones (full-canvas pixel payloads).
- **Debug affordances ship.** `window.__paintpad` is attached unconditionally, including in
  production builds. Fine for the harness; gate it behind `import.meta.env.DEV` when the real
  UI shell lands.
- **No secondary colour.** Right-drag does not paint with colour 2 (the Paint convention).
  The eraser is a manual tool switch only.
- **Raster scale 2 ceiling.** Output is soft on a 3× display zoomed past 200%.
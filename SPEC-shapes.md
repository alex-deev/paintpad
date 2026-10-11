# Spec: Shapes (Slice 3)

## Objective

Add line, rectangle, and ellipse tools on top of the slice-2 history system.

**User story:** As a user, I can draw straight lines, rectangles, and ellipses — filled or
outlined — and undo them exactly like strokes.

**Why now:** A shape is just another record type feeding the same `renderRecord` path, with
undo already underneath it. The pieces that made this cheap were locked in earlier: a
versioned-style discriminated `kind`, a history that stores records opaquely, and the
requirement that live preview and commit use the *same* renderer.

## Assumptions

1. Shapes only. No flood fill, text, selection, or move/resize (those are later slices).
2. Outlined by default, with a Fill toggle that fills using the foreground colour.
   Deliberately *not* Paint's "fill with colour 2" convention, which produces invisible
   white shapes on the default white background.
3. `Shift` constrains: 45° angles for lines, squares for rectangles, circles for ellipses.
4. A drag with no extent commits nothing. Paint likewise ignores a zero-size shape.
5. Shape width is in logical pixels, like stroke width.

## Tech Stack

Unchanged. No new dependencies. `shape.ts` is pure and DOM-free, covered by the node suite.

## Core Design

**Geometry is pure.** `shape.ts` owns normalisation and constraint maths and knows nothing
about canvas:

```ts
normalizeShape(kind, from, to, constrain) → NormalizedShape
isDegenerate(shape) → boolean
```

**Rendering reuses one path.** `renderRecord` dispatches on `record.kind`. The in-progress
shape preview and the committed shape call the *same* function on the same record, so a
preview can never differ from what gets committed — the bug class the design review flagged
as "shape-preview path has no stated renderer".

**Ellipses use `ctx.ellipse()`**, not two half-arcs. Two arcs leave a visible seam where they
meet and mis-handle antialiasing at the join; one primitive does both correctly. A dedicated
golden guards the seam.

## Locked Decisions

| # | Decision | Rejected alternative |
|---|----------|---------------------|
| 1 | `ShapeRecord` is a new member of the record union; history treats it opaquely | A separate shape history, or snapshotting during a drag |
| 2 | Preview and commit both call `renderRecord` | A lighter-weight "preview renderer" that can drift from the real one |
| 3 | Shift snapping is computed in `shape.ts`, not in the pointer handler | Inline maths in the engine — untestable without a browser |
| 4 | `ctx.ellipse()` for ellipses | Two `arc()` calls (visible seam, wrong AA at the join) |
| 5 | A zero-extent drag commits nothing | Committing a degenerate record that renders as a stray dot |
| 6 | Fill uses the foreground colour | Paint's colour-2 fill, which is invisible on the default background |

## Testing Strategy

**Unit (node, `shape.ts`, 100% coverage):**
- Unconstrained normalisation is a pass-through
- Line angle snaps to the nearest 45° while **preserving length**
- Rect/ellipse constraint forces a square/circle from either drag direction
- Negative (up-left) drags constrain correctly
- Degenerate detection for zero length, zero width, and zero height
- A single point is degenerate

**E2E (goldens):**
- Diagonal line, horizontal line, and vertical line
- Shift-constrained line at 45°
- Filled rectangle and outlined rectangle
- Filled ellipse — **seam check** (the `ctx.ellipse()` guard)
- Degenerate drag commits nothing (ink count unchanged)

**E2E (behavioural):**
- Undo removes a shape; redo restores it byte-identically
- A shape survives a zoom round trip
- Shapes and strokes interleave in one history and undo in the correct order

## Boundaries

**Always**
- `shape.ts` stays pure — no canvas, no DOM
- Preview and commit go through the same `renderRecord`
- Set every context property a renderer reads, inside `save()`/`restore()`

**Ask first**
- Adding a fourth shape kind
- Making shapes draggable/resizable after commit (that is a selection feature)
- Changing the `ShapeRecord` shape (invalidates stored histories)

**Never**
- Render a shape with a code path that commit does not also use
- Mutate a record after committing it

## Success Criteria

1. `npm run test` passes with 100% coverage on `shape.ts` alongside the other pure modules
2. Line, rectangle, and ellipse all draw, outlined and filled
3. `Shift` constrains a line to 45° increments, a rectangle to a square, an ellipse to a circle
4. A filled ellipse shows **no** seam
5. A zero-extent drag commits nothing
6. Undo and redo work on shapes and produce byte-identical results to strokes
7. Interleaved shape and stroke history undoes in the correct order
8. `npm run test:all` passes with no regressions to slice 1 or slice 2 tests

## Open Questions

None.
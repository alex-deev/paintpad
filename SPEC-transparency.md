# Spec: Transparency (Slice 5)

## Objective

Give the document a real alpha channel, and make the eraser erase to transparency instead of
painting a colour.

**User story:** As a user, I can erase to nothing and export an image with real
transparency, rather than painting white over things.

**Why now:** Transparency changes the document model, the eraser's meaning, PNG export, and
how fill behaves on an alpha channel. Every one of those leaks into later slices. Settling it
before flood fill is cheaper than retrofitting it twice.

## Scope Boundary

**In:** RGBA canvas, transparent new documents, `destination-out` eraser, checkerboard UI,
alpha-aware helpers, history that records erases.

**Out:** translucent colours in the picker, PNG export UI, layer compositing.

Opaque colours on a transparent canvas is a complete, coherent feature. Alpha in the picker
is a separate increment, not a prerequisite for it.

## Core Design

**`StrokeRecord.composite` finally earns its keep.** Slice 1 put a `composite` field on the
record "so slice 2 eraser/alpha requires no record-type change". That foresight pays off: an
erase is a stroke record with `composite: "destination-out"`, not a new record type.

**No second overlay canvas.** A mask canvas would cost another full raster (~14.7 MB at the
default document size). Instead the in-progress erase is drawn directly onto the view with
`destination-out` during compositing:

```
view = clear
     → drawImage(base)
     → drawImage(overlay)          // additive work in progress
     → if erasing: destination-out, stroke the current erase record
```

During an erase gesture the additive overlay is empty by construction, so erasing last is
equivalent to erasing only the base — without allocating anything.

**Records store parameters, not pixels.** An erase records its points and width; replay
re-executes it. Nothing about an erase is a stored `ImageData` blob, which keeps history
JSON-safe.

## Locked Decisions

| # | Decision | Rejected alternative |
|---|----------|---------------------|
| 1 | New documents start transparent | Starting white — the feature would be invisible until the first erase |
| 2 | Eraser is always `destination-out` | Keeping "paint colour 2" — that erases to opaque colour, not to nothing |
| 3 | Erase previews by compositing onto the view | A dedicated mask overlay canvas (another full raster in memory) |
| 4 | Colours stay opaque this slice | Adding alpha to the picker now — it enlarges the palette UI, the hex parser contract, and record validation for no gain |
| 5 | `documentInkCount` counts alpha > 0 | Comparing against a background colour — there is no background any more |
| 6 | `reset()` clears to transparent | Filling with the secondary colour — "New" should mean nothing, not white |
| 7 | Colour 2 is retained as a plain second painting colour | Deleting it — swapping is still useful, it just stops being the eraser's job |

## Testing Strategy

**Unit (`stroke.test.ts` additions):** nothing — records are data.

**E2E — the properties that matter:**
- A new document is fully transparent (alpha 0 everywhere)
- Erasing leaves **alpha 0**, not white — asserted directly on the alpha channel, which is
  the single assertion that distinguishes this from the old behaviour
- Erasing restores the pixels on undo
- An erase survives an undo/redo round trip byte-identically
- Drawing on a transparent document produces premultiplied-safe opaque pixels
- Transparent regions survive a zoom round trip
- `documentInkCount` is 0 on a fresh transparent document and non-zero after drawing

**Goldens** changed wholesale — they were captured against an opaque white canvas. They are
regenerated and **visually inspected**, because a transparent PNG can render deceptively in
an image viewer.

### A limitation these goldens do not cover

While regenerating, the goldens initially *passed* against the old opaque-white baselines
even though the render had become transparent (20,212 bytes live vs 20,355 on disk).

Investigating: Playwright's image comparison **treats fully transparent pixels as
"don't care"**. Proven both ways — swapping in a different valid PNG fails the test, so
comparison is real; but a background that changed from white to transparent does not.

Consequence: the goldens verify **strokes** (beading, tails, dots, seams) and always did,
but they **cannot** verify background or alpha. Anything about transparency has to be
asserted on the alpha channel directly, which is what `transparency.spec.ts` does.

Do not read a passing golden as evidence that the document background is correct.

## Boundaries

**Always**
- Never fake transparency by painting a background colour
- Composite the erase inside a `save()`/`restore()` pair and reset
  `globalCompositeOperation` to `source-over` afterwards

**Ask first**
- Making erase itself undoable-within-a-gesture
- Adding alpha to the colour picker
- Backing the document with anything other than a plain RGBA raster

**Never**
- Leave `globalCompositeOperation` mutated after compositing
- Assume a background colour exists anywhere in the document

## Success Criteria

1. A new document is transparent — alpha 0 across the canvas
2. The eraser produces alpha 0, not opaque white
3. Undo restores erased pixels; redo re-erases
4. Drawing on a transparent document commits opaque pixels
5. `documentInkCount` is alpha-based and correct on an empty document
6. `reset()` yields a transparent document
7. All 61 existing e2e tests still pass, with goldens regenerated and inspected
8. `npm run test:all` green, 100% coverage on the pure modules

## Open Questions

- Whether a new document should default to transparent or white is the one product call here;
  transparent was chosen because white makes the feature unobservable.
- PNG export preserving alpha is straightforward once the document is RGBA, but the export UI
  itself is a later slice.
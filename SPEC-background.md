# Spec: Canvas Background (Slice 6)

## Objective

Let the user set a canvas background colour, which erases restore to.

**User story:** As a user, I can choose whether my canvas is transparent or a solid colour,
and when it is a solid colour the eraser restores that colour rather than punching through to
the checkerboard.

**Why now:** Slice 5 made documents transparent, but left no way to opt out. A transparent
default is right for new work and wrong for anyone drawing something they intend to export on
white — and "background" was already a dead concept: colour 2 was left with no job at all once
the eraser stopped using it.

## Scope Decision — colour 2 *becomes* the background

Rather than adding a third colour control, the existing **secondary swatch becomes the canvas
background**. Three colour concepts (foreground, colour 2, canvas background) would be
confusing when two of them are never used.

| Slot | Meaning |
|------|---------|
| Primary swatch | The colour you draw with |
| Secondary swatch | The canvas background — `null` means transparent |

## Locked Decisions

| # | Decision | Rejected alternative |
|---|----------|---------------------|
| 1 | The background is a **document property**, filled beneath all art | A CSS backdrop only — it would not appear in exports |
| 2 | It is **not an undoable operation** | Making it a record — canvas size is not undoable either, and users expect undo to remove *marks*, not document settings |
| 3 | The eraser **restores the background** when one is set | Always `destination-out` — erasing through a white background would reveal the checkerboard, which surprises anyone coming from Paint |
| 4 | Erasing with **no** background still erases to true transparency | Erasing to an implicit white — that would erase the transparency feature |
| 5 | New documents stay transparent | White by default — transparency stays the explicit, opt-in choice |
| 6 | `documentInkCount` compares against the background when one is set | Always counting alpha > 0 — with a solid background every pixel is opaque and "ink" would mean "the whole canvas" |
| 7 | Swap is a no-op when there is no background colour | Swapping a colour with "nothing" |

## Core Design

The background lives on the engine as `background: string | null`, **not** on `DocModel`.
`DocModel` models geometry and raster scale; mixing in style would make every doc comparison
carry a field nothing reads. Nothing is persisted yet, so this also avoids an invalidation
question entirely.

`repaintBase()` fills the background first, then replays history — so the background is always
beneath every mark, and changing it never disturbs the art.

The eraser's composite is decided **at gesture time** and stored in the record, so replay
reproduces exactly what happened:

```
background === null  →  composite: "destination-out",  colour ignored
background !== null  →  composite: "source-over",     colour: background
```

## Testing Strategy

**E2E — the behaviours that distinguish this from the alternatives:**
- A fresh document is transparent
- Setting a background fills the whole canvas opaquely
- Clearing it returns the canvas to transparency
- **Eraser with a background restores that colour** (opaque, matching) — the assertion that
  distinguishes decision 3 from decision "always punch through"
- **Eraser with no background erases to alpha 0** — preserves decision 4
- Existing art survives a background change
- The background is **not** undoable: undoing a stroke leaves it in place
- Undo of an erase still restores pixels, with a background set
- `documentInkCount` is 0 on a cleared canvas in both modes, and non-zero after drawing
- Swap is inert with no background, and exchanges colours when one is set
- The background survives a zoom round trip

**Goldens** are unaffected: Playwright treats transparent pixels as "don't care", and the
existing goldens draw strokes on an empty (transparent) canvas, which does not change.

## Boundaries

**Always**
- Fill the background before replaying history, never after
- Normalise any colour handed to the engine; reject invalid input
- Decide the eraser's composite at gesture time and store it in the record

**Ask first**
- Making the background undoable
- Supporting a gradient or image as a background
- Moving the background onto `DocModel`

**Never**
- Repaint the background over existing art
- Assume the background is a string — it is `string | null`

## Success Criteria

1. Default documents are transparent
2. A background colour can be set and cleared, and fills the canvas beneath art
3. Erasing with a background restores that colour; without one, erases to alpha 0
4. The background survives undo of strokes and of erases
5. `documentInkCount` is correct in both modes
6. Swap behaves correctly in both modes
7. `npm run test:all` green with no regressions to the other 159 tests

## Open Questions

None. The eraser and default behaviour were both settled with the user before implementation.
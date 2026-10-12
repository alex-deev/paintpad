# Spec: Rectangular Selection — Marquee and Delete (Slice 10)

## Objective

Select a rectangular region and delete its contents.

**User story:** As a user, I can drag a box over part of my drawing and remove it.

**Why now:** Selection is the capability people actually notice missing. It is also the first
feature whose core operation is a **pixel operation** — a move, a cut, a paste — and this slice
exists to find out whether the record model survives that, before two more slices are built on
top of it.

## The Question This Slice Answers

Every record so far has been a pure draw or a parameterised read-modify-write. Deleting a
region is the first thing that is neither.

- **Store the `ImageData` patch** — rejected. This is exactly the trap that has deferred image
  import twice: `JSON.stringify` destroys `ImageData`, so autosave would silently corrupt any
  document containing a selection.
- **Store the rect and clear it** — chosen. `clearRect` on the base at integer coordinates is
  exact, needs no anti-aliasing story, and replays to the same pixels every time.

If a pixel-shaped operation can be expressed as a parameter replayed onto the base, then
slice B's `move` record — which stores the records that produced the region and re-renders
them translated and clipped — has a foundation worth building on.

## Locked Decisions

| # | Decision | Rejected alternative |
|---|----------|---------------------|
| 1 | Delete is a **`clearRect` record**, replayed onto the base | An `ImageData` patch — breaks JSON-safety and therefore autosave |
| 2 | Rects are **integer raster coordinates**, floored at the min and ceiled at the max | Rounding, which can exclude a pixel the user visibly covered; float rects, which seam on delete |
| 3 | The marquee is **view state**, never a record | Persisting it would put transient UI into the document and into autosave |
| 4 | Delete **keeps the selection active** | Clearing it means a second Delete does nothing and undo leaves you with no way back |
| 5 | Switching away from `select` **clears the selection** | Leaving it live lets Delete silently erase something the user can no longer see |
| 6 | A click with no drag **clears the selection and records nothing** | A zero-size rect would add a no-op record to every stray click |
| 7 | Deleting shows the **background** through the hole | Clearing to the background colour — the background is composited, never baked in, so this falls out for free |
| 8 | `clearRect` sets an identity transform defensively | Trusting the caller — a leftover scale is the ghost-pixel bug from slice 1, and `clearRect` is subject to it |

## Boundaries

**Always**
- Snap to integer raster pixels
- Reject degenerate rects before committing a record
- Route deletion through `commit()` so undo needs no special case

**Ask first**
- Moving, resizing, or rotating the selection
- Copy / paste
- Feathered or non-rectangular edges
- Dimming the selected region

**Never**
- Put an `ImageData` in a record
- Persist the marquee

## Known Consequence

Deleting at integer coordinates leaves a hard edge against whatever anti-aliasing the original
stroke left there, so a deleted region can look slightly harder-edged than one drawn by hand.
That is correct — the pixels really were removed — but it is worth naming before it gets
mistaken for a rendering bug.

## Testing Strategy

**Unit (`selection.ts`, 100% coverage, node):**
- `normalizeRect` across all four drag directions
- Floors the min and ceils the max, so a fractional drag always covers what was drawn over
- A zero-length drag on an integer point is empty
- `isEmptyRect` for zero, negative, and positive extents

**E2E:**
- Marquee + delete removes the covered pixels and leaves neighbours untouched
- Undo restores byte-identically
- A click without a drag clears the selection and adds no record
- Delete with no selection adds no record
- Switching tools clears the selection
- The marquee survives a zoom round trip
- Delete survives a reload, because it is a record

## Success Criteria

1. Drag a box, press Delete, and exactly that region is gone
2. Undo restores it
3. No degenerate record is ever added
4. `npm run test:all` green with no regressions
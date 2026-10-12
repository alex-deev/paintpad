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

## Slice 11 — Move

**Added after slice 10 shipped.** The design below replaces the sketch at the bottom of this
document, which did not survive contact with the renderer.

### The flaw in the original plan

The plan was to store the records that produced the region and re-render them clipped and
translated on the main context. Two problems, only visible once written down:

- **Nested fills ignore transforms.** `applyFill` uses `getImageData`/`putImageData`, which
  are transform-independent, so a fill inside a moved region would ignore both the clip and
  the offset. `applyClearRect` sets an identity transform defensively and would defeat a
  translate for the same reason.
- **History grows multiplicatively.** Without bounds filtering, each move embeds the entire
  prior log, making N moves O(N²) in the autosave.

### The move record

`{kind:"move", records, dx, dy, clip}` — still parameters, still JSON-safe, still replayable.

Replay is **render the region to a scratch canvas, then blit it**:

1. Size a scratch canvas to `clip` and clear it.
2. Translate by `-clip` so nested records draw at their original coordinates.
3. Apply every nested record to the scratch canvas.
4. `drawImage` the scratch at `clip` + `(dx, dy)`, smoothing disabled.

The scratch canvas *is* the clip, which handles any record kind uniformly — a nested fill is
correct because it runs against its own canvas rather than a transformed one. Blitting at
integer offsets with smoothing off copies pixels exactly, so anti-aliasing inside the region
survives the move unchanged.

Nested records are filtered at commit time to those whose bounds intersect `clip`, which is
what keeps the nesting from growing without bound. A `fill` record's extent is genuinely
unknown without replaying it, so fills are always included; that is cheap, since a fill record
is four fields.

### Moving leaves the source transparent

Clearing the source rect and moving the content is consistent with delete: the background is
composited beneath the artwork and shows through with no special handling. Baking the
background colour in would reintroduce the frozen-pixel bug fixed in the background slice.

### Interaction

- Dragging **inside** the selection moves it; dragging **outside** starts a new one, matching
  Paint.
- The preview is the marquee outline only. A true content preview would need the base mutated
  during the drag, which breaks the invariant that the canvas is derived from history — the
  same reason flood fill does not preview.
- The move commits on release, so a cancelled gesture leaves nothing behind.

### Two bugs this slice found in itself

Both were found by a test asserting a property a move must have — **it conserves pixels** —
and neither was visible from reading the code.

**One scratch canvas is not enough.** `applyMove` renders nested records into a scratch
surface, so a second move of the same selection nests the first `move` record and re-enters
the function. Sharing one canvas resized it mid-render and duplicated artwork: moving the same
selection twice grew the document from **29,561 pixels to 41,588**. Fixed with a pool indexed
by nesting depth, which bounds allocation by the deepest nesting actually reached.

**Forcing an identity transform is wrong once records nest.** `applyClearRect` set identity
defensively, which is good advice everywhere else in this codebase and actively wrong here: a
selection spanning an earlier deletion nests that `clearRect`, and forcing identity cleared the
wrong rectangle, filling the deleted gap back in and **growing the artwork by 8,664 pixels**.
The identity contract now belongs to `applyRecord` and its two top-level callers, where the
ghost-pixel protection actually lives.

The lesson worth carrying: the defensive `setTransform(identity)` sprinkled through this
renderer was right until records could nest, at which point it became a bug in both directions.

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
# Spec: PNG Export (Slice 7)

## Objective

Let the user download the document as a PNG.

**User story:** As a user, I can keep what I have drawn.

**Why now:** This is the gap that matters most. Every feature so far is lost on refresh —
the app has no way to keep work, which makes the rest untestable in real use. The hard part
is already done: `snapshotDataUrl()` composites the background beneath the artwork, so the
pixels are correct and export is plumbing.

**Export only.** Opening images is deliberately a separate slice: an opened PNG is not
reconstructible from commands, so it must enter history as a `{kind:'pixels', ImageData}`
record — and `JSON.stringify` silently destroys `ImageData`. That encoding question belongs
with the autosave design, not smuggled in here.

## Locked Decisions

| # | Decision | Rejected alternative |
|---|----------|---------------------|
| 1 | Export at the **document's raster size**, not the view's | Exporting the view canvas — that would bake in the current zoom and `devicePixelRatio`, producing a 1031×580 file on a 1280×720 document |
| 2 | A **blob**, not a data URL | `toDataURL` base64-encodes ~15 MB of pixels into a giant string on the main thread |
| 3 | Compositing lives in the engine; the `<a download>` plumbing lives in the UI | Either the other way round — the engine has no business creating anchors, and the UI has no business compositing |
| 4 | One `renderDocument()` shared by export and `snapshotDataUrl()` | Two copies of the composite that can drift apart |
| 5 | Filename is timestamped: `paintpad-<YYYYMMDD-HHMMSS>.png` | A fixed name — browsers suffix duplicates with `(1)`, `(2)`, which is noise |
| 6 | Exporting an empty document produces a valid blank transparent PNG | Blocking the export when there is nothing drawn |

## Note on Resolution

The default document is 1280×720 logical at `rasterScale: 2`, so it exports as
**2560×1440**. That is not a mistake: strokes are genuinely rasterized at 2×, so the document
really is that size. Exporting at the document's own resolution is the honest reading, and it
is why the fixed raster scale matters — the file is the same pixels regardless of the display
it was drawn on.

## Implementation

1. **`Engine.renderDocument(): HTMLCanvasElement | null`** — composites background + artwork
   into a scratch canvas at the document's raster size. Single source of truth.
2. **`Engine.snapshotDataUrl()`** — delegates to `renderDocument()`, then `toDataURL`.
3. **`Engine.exportBlob(): Promise<Blob | null>`** — `renderDocument()` then `toBlob('image/png')`.
4. **UI** — an Export button that awaits the blob, builds an object URL, clicks a synthetic
   anchor, and revokes the URL afterwards.

## Testing Strategy

**E2E — an actual file, not a mocked download:**
- Clicking Export produces a real download with a timestamped `.png` filename
- The downloaded file's pixel dimensions equal the **document raster size**, not the view's
- Zoomed to 400%, the exported file is **identical** to one exported at fit — export must be
  zoom-independent
- A document with a background exports with that background composited in
- A document with no background exports with genuine transparency (alpha 0 in empty regions)
- The exported file at `deviceScaleFactor` 1 and 3 is byte-identical — the same guarantee as
  `dpr.spec.ts`, now verified through the real file

## Boundaries

**Always**
- Revoke the object URL after the download; do not leak blobs
- Export from the document raster, never the view

**Ask first**
- Export formats other than PNG (JPEG would flatten alpha; WebP and AVIF have uneven support)
- Choosing an export resolution different from the document's
- Opening images (see "Why now")

**Never**
- Read pixels from the view canvas for an export
- Block an export because the document is empty

## Success Criteria

1. Export downloads a PNG named `paintpad-<timestamp>.png`
2. The file's dimensions match the document raster, and are **unchanged by zoom**
3. The background is composited into the file
4. No background means real transparency in the file, not white
5. Exports at `deviceScaleFactor` 1 and 3 are byte-identical
6. `npm run test:all` green, with no regressions

## Householding Folded In

`window.__paintpad` is a debug handle that currently ships to production builds. It is gated
behind `import.meta.env.DEV`. The e2e suite runs against the dev server, so tests keep
working — but nothing exposes internals in a shipped build.
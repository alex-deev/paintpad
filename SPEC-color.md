# Spec: Colour (Slice 4)

## Objective

Add a colour bar with a preset palette, custom HEX entry, and Paint's two-colour
(primary/secondary) model.

**User story:** As a user, I can pick drawing colours from a palette or type any hex value,
and the eraser erases with the colour I choose rather than always white.

**Why now:** Colour is a prerequisite for every remaining feature — flood fill needs a colour
to fill *with*, text needs a text colour, selection needs contrasting outlines. Doing it now
means those slices inherit it instead of retrofitting it.

## Assumptions

1. **Opaque colours only.** `#rrggbb`, never `#rrggbbaa`. Alpha is explicitly rejected by the
   parser so a stray alpha value can never enter a record.
2. No transparency: the canvas is always fully opaque, the eraser paints the secondary colour,
   and PNG export stays opaque. See "Deferred" below.
3. Primary colour draws; secondary colour is what the eraser paints with.
4. The palette is a curated preset list plus a native `<input type="color">` and a HEX field.
   No new dependency.
5. Shapes keep filling with the *primary* colour (slice 3 decision, unchanged).

## Tech Stack

Unchanged. No new dependencies — `<input type="color">` and CSS cover custom picking.

## Core Design

**Pure colour helpers in `color.ts`**, so validation is testable without a browser:

```ts
normalizeHex(raw)      → "#rrggbb" | null   (rejects alpha forms)
parseHex(hex)          → {r, g, b}
readableTextOn(hex)    → "#000000" | "#ffffff"  (swatch label contrast)
DEFAULT_PALETTE        → readonly string[]
```

**Two colour slots on the engine.** `BACKGROUND` is currently a module constant read in three
places — the eraser, the canvas fill on reset, and the ink counter. All three must read
`this.background` instead, or the eraser keeps erasing to white regardless of what is chosen.

**Colours are baked into records at commit time.** This is already true by design and is the
property the headline test protects.

## Locked Decisions

| # | Decision | Rejected alternative |
|---|----------|---------------------|
| 1 | Opaque hex only; the parser rejects `#rrggbbaa` | Silent alpha support — it would make documents RGBA, change eraser meaning, and produce transparent PNGs |
| 2 | An explicit **active slot** (primary/secondary) the palette edits | Paint's left-click/right-click convention — undiscoverable and untestable |
| 3 | The engine normalises any colour it is handed, ignoring invalid input | Trusting the UI to always pass valid hex — one bad value poisons every future record |
| 4 | `documentInkCount` compares against the **actual background**, not white | Keeping the white threshold — it reports every pixel as ink once the background is dark |
| 5 | Recents persist to `localStorage` | Session-only — recents that vanish on reload are barely worth the space |
| 6 | Swap is a button and `X`, not a drag gesture | Gesture-only swap — undiscoverable |

## Testing Strategy

**Unit (`color.ts`, 100% coverage):**
- `normalizeHex` accepts `#abc`, `abc`, `#aabbcc`, upper/lower case, surrounding whitespace
- `normalizeHex` rejects empty, `#`, non-hex digits, wrong lengths, `red`, and **alpha forms**
- `readableTextOn` returns dark text on light backgrounds and vice versa

**E2E — the headline test:**
> Draw a stroke in red → switch the palette to blue → undo → redo → **the stroke is still red**

This proves colour is captured in the record rather than read at replay time.

**Other E2E:**
- Choosing a palette colour changes what the next stroke draws
- A custom HEX value applies to the next stroke
- Invalid HEX leaves the colour unchanged and is rejected
- Swap exchanges primary and secondary
- The eraser paints the **secondary** colour, not white
- Reset paints the current secondary colour as the canvas background
- `documentInkCount` reports 0 on a freshly cleared dark-background canvas
- Switching to a dark background, drawing, and undoing still works

## Boundaries

**Always**
- `color.ts` stays pure — no DOM, no canvas
- Normalise every colour entering the engine
- Bake resolved colour into records; never re-read live state at replay

**Ask first**
- Accepting 3-digit or alpha hex at the engine level
- Changing the eraser from "paint secondary" to `destination-out`
- Adding a gradient or pattern fill

**Never**
- Let an invalid colour reach a record
- Assume white when comparing against the background
- Re-read the current palette colour during replay

## Success Criteria

1. `npm run test` passes with 100% coverage on `color.ts` alongside the other pure modules
2. Palette, native picker, and HEX entry all set the active colour slot
3. The eraser paints the secondary colour
4. Reset paints the secondary colour as the canvas background
5. Colour is baked into records — changing colour and undo/redo restores the original
6. Invalid HEX is rejected without changing state
7. `documentInkCount` is correct for dark and light backgrounds
8. `npm run test:all` passes with no regressions

## Deferred

Transparency (RGBA documents, true `destination-out` erase, checkerboard UI, alpha PNG
export). The rendering architecture already supports it cheaply — slice 1 rebuilds the full
path per frame — but the *document model*, eraser semantics, and export all change. It
deserves its own decision, not an accident inside a colour picker.

Also still queued: flood fill, text, selection/clipboard, the full UI shell, persistence.
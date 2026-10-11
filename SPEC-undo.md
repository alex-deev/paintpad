# Spec: Undo/Redo (Slice 2)

## Objective

Make the committed record list the **single source of truth** for the document. Drawing,
replay, and undo must all produce identical pixels.

**User story:** As a user, I can undo and redo any stroke, and the result is exactly the
canvas state I had before — not a close approximation.

**Why now:** Slice 1 established the render engine and deliberately deferred the command
log to this slice. `commit()` already takes a `StrokeRecord` and `renderRecord` is already
self-contained, so replay drops straight in with no rework of slice 1 code.

## Assumptions

1. Undo/redo only. No shapes, flood fill, text, selection, or persistence — those are later
   slices, each of which inherits a working undo.
2. Replay-from-blank, with **no raster checkpoints** in this slice.
3. The eraser stays `source-over` background painting; undo must restore erased pixels.
4. `reset()` ("Clear") discards history rather than becoming an undoable step.

## Tech Stack

Unchanged from slice 1. No new dependencies. The history reducer is pure and DOM-free, so it
is covered by the existing node unit suite.

## Commands

```
Test:      npm run test         # vitest + 100% coverage thresholds
E2E:       npm run test:e2e
All:       npm run test:all
```

## Core Design — history as a pure reducer

```ts
interface History {
  readonly entries: readonly StrokeRecord[];
  readonly cursor: number; // how many entries are currently applied
}
push(history, record)  // append + advance cursor, TRUNCATE the redo tail
undo(history)          // cursor - 1, floored at 0
redo(history)          // cursor + 1, capped at entries.length
```

The canvas is rendered as `replay(entries.slice(0, cursor))`.

**No checkpoints.** At 1280×720 @ rasterScale 2 a full raster is 14.7 MB, so 25 checkpoints
is ~368 MB — and checkpoints introduce the worst undo bug in the project: undo truncates the
entry list, so every checkpoint past the cut describes pixels that no longer exist,
producing undo states the user never saw and which are indistinguishable from corruption.

Skipping them is justified by measurement, not intuition: `replayBenchmark` replays 1,000
synthetic records and asserts it stays under 100 ms. Measured on this document size, 1,000
records replay in roughly **40 ms**.

The budget is deliberately not a frame budget. Undo and redo are discrete user actions, not
per-frame work, so the bar is "well under the ~100 ms where a user perceives a hang". An
earlier draft used 16 ms — a per-frame budget applied to a non-per-frame operation, which was
the wrong model rather than a regression.

## Locked Decisions

| # | Decision | Rejected alternative |
|---|----------|---------------------|
| 1 | History is a pure reducer over `{entries, cursor}` | Storing snapshots (8 MB each at 1080p; 100 steps OOMs) |
| 2 | Replay from blank on every undo | Raster checkpoints (memory + stale-state bug) |
| 3 | Determinism is guaranteed **within a session and across reloads on the same browser build**, not across devices | "Byte-identical everywhere" — unachievable against the platform rasterizer (GPU vs CPU paths, SwiftShader fallback, context promotion, AA changes between browser versions) |
| 4 | `push` after an undo truncates the redo tail in the same operation | Lazily invalidating the tail (leaks, and lets stale state leak into a later replay) |
| 5 | Context options (`colorSpace`, `willReadFrequently`) pinned in one auditable place | Implicit defaults — GPU-vs-CPU backing changes rasterization and is chosen at `getContext` time |
| 6 | `reset()` clears history; it is not undoable | Making it a record (Paint's "New" is not undoable) |
| 7 | Only **text-entry** targets swallow shortcuts (`isTextEntryTarget`) | Blocking all `<input>` — a focused range slider would silently disable undo and the tool keys |
| 8 | Replay budget is 100 ms, not one frame | A frame budget is the wrong model; undo is a discrete action, not per-frame work |

## Testing Strategy

**Unit (node, pure)** — `history.ts`, 100% coverage enforced:
- `push` appends and advances the cursor
- `push` after an undo **truncates** the redo tail (the branch case)
- `undo` decrements and floors at 0; `redo` increments and caps at `entries.length`
- Entries are never mutated — `entries` is append-only and trimmed only from the tail
- `push` does not mutate the input history

**E2E (Playwright)** — the decisive ones:
- **Replay identity:** draw N strokes → capture committed pixels → clear → replay → capture
  again → **byte-identical**. This is the invariant that would break first if live
  rendering and replay diverged.
- Undo-to-blank restores a pristine document
- Undo is lossless: N undos then N redos equals the original pixel state exactly
- Undo then draw discards the redo tail (redo button becomes disabled)
- Eraser then undo restores the erased pixels
- Keyboard `Ctrl+Z` / `Ctrl+Shift+Z` / `Ctrl+Y`
- Undo/redo button disabled states at the ends of history

**Benchmark** — replay 1,000 synthetic records under 16 ms.

## Boundaries

**Always**
- `history.ts` stays DOM-free and pure
- Never mutate `entries` in place; always return a new object
- Undo must re-render through the same `renderRecord` path as drawing

**Ask first**
- Introducing raster checkpoints
- Changing the `StrokeRecord` shape (invalidates stored histories)
- Making `reset()` undoable

**Never**
- Replay a command through a different code path than live drawing
- Claim cross-device determinism
- Make the canvas the source of truth (it is always derived from `entries`)

## Success Criteria

1. `npm run test` passes with 100% coverage on `history.ts` alongside the slice 1 pure modules
2. Replay of N drawn strokes is **byte-identical** to what was drawn live
3. Undo N times then redo N times restores the exact original pixels
4. Undo past the start is a no-op; redo past the end is a no-op
5. Drawing after an undo discards the redo tail
6. Undoing an eraser stroke restores the pixels it covered
7. Replaying 1,000 records completes in under 100 ms
8. `Ctrl+Z` / `Ctrl+Shift+Z` / `Ctrl+Y` work — **including while the size slider has focus**
9. `npm run test:all` passes with no regressions to any slice 1 test

## Open Questions

None. Scope confirmed as undo/redo only.
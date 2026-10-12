# Spec: Autosave (Slice 9)

## Objective

Persist the document so a refresh or a closed tab does not lose work.

**User story:** As a user, I can close the tab and come back to exactly what I left.

**Why now:** Every other gap is missing functionality. This one loses work that was already
done, and it is the prerequisite that makes image import tractable.

## Locked Decisions

| # | Decision | Rejected alternative |
|---|----------|---------------------|
| 1 | **IndexedDB**, not localStorage | A measured command log is ~1 MB per 1,000 strokes, so localStorage's 5 MB quota holds only ~400 strokes — it would work in testing and fail mid-session, which is worse than not shipping |
| 2 | Store the **command log**, not a raster | The log is the source of truth already; a saved PNG would need a separate restore path and would break the "canvas is always derived" invariant |
| 3 | **One slot**, no document list | Multiple saved documents is a feature, not a prerequisite |
| 4 | Save schema has its **own version**, separate from `DocModel.v` | They change for different reasons — a save format change should not invalidate documents whose raster model is unchanged |
| 5 | Split into a **pure `serialize.ts`** and a thin `storage.ts` | Testing IndexedDB logic directly means an untestable module; the interesting logic (encode, decode, validation) stays pure and 100%-covered, and only three storage calls are left to e2e |
| 6 | `decode` **filters records by `kind`** and clamps the cursor | A malformed record throws during replay, turning a bad byte into a boot crash. Losing one edit beats losing the tab |
| 7 | **No migration.** An unknown version discards the save | Untestable migration paths are worse than a clean start at v1 |
| 8 | Restore **silently**, including the cursor | A user who reloads mid-undo should still be able to redo |
| 9 | `Clear` wipes the save as well as the canvas | Otherwise the next reload resurrects what was just cleared |

## Addendum — decisions forced by testing

Three of these only became visible once the slice was running. All three were bugs, not
preferences.

**A synchronous fallback for the final write.** Autosave reads the store before attaching the
engine, so IndexedDB is async everywhere. That is fine for the debounced history, but a
transaction begun *while the page is unloading* generally never commits — verified by
instrumenting it: the debounce fired mid-stroke, kicked off a write, and the reload restored a
**one-stroke** save while the document had two. The final write therefore goes to
`localStorage.setItem`, which is synchronous and always commits. IndexedDB remains the durable
store; this is only the last-gasp slot.

**The flush must not be conditional.** The first version skipped the flush when no debounce
was pending, reasoning the write had already gone out. That reasoning is wrong in exactly the
case that matters: `lastSaved` records what was *attempted*, never what is durable. The flush
is now unconditional and gated on nothing.

**The fallback is not consumed on read.** Removing it on read was one-shot, and React's
StrictMode invokes the boot effect twice — so the first read took the fallback and the second,
the one that survives, fell through to a stale IndexedDB save and quietly restored the *wrong*
document. The fallback is now cleared by `saveDocument`, once IndexedDB actually holds
something at least as new.

**Boot is asynchronous, so the canvas waits for it.** With restore in front of `attach`, the
canvas could be visible before its pointer handlers were wired — a user could click and paint
nothing. It stays hidden until ready. This makes `toBeVisible()` a boot barrier in the e2e
suite, which is why the global expect timeout was raised; the alternative was leaving a real
race in the app to keep the tests fast.

## Data Shape

```ts
interface SavedDocument {
  v: number;                    // save schema version
  doc: DocModel;                // size + rasterScale
  background: string | null;    // document setting, not undoable
  entries: PaintRecord[];       // the command log
  cursor: number;               // where the user had undone to
}
```

Every field is already JSON-safe. `FillRecord` is `{seed, colour, contiguous}` — storing
parameters rather than pixels is what makes this work, and it was decided back in slice 8
for exactly this reason. `ImageData` is the one value that would not survive `JSON.stringify`,
and image import stays out of scope until that is resolved.

## What Makes This Work

Replay is re-run against reconstructed artwork, not stored. Fills in particular re-derive
themselves from a seed, so restore needs no special case per record kind.

The determinism contract is already scoped to "byte-exact within a session and across reloads
on the *same browser build*". Autosave is the first time that contract is load-bearing across
a **session boundary**, which is why the draw → reload → compare-bytes e2e is the most
important test in the slice.

## Failure Handling

All four degrade to a clean document and must never break drawing:

1. **Corrupt or truncated JSON** — `decode` returns null, the save is ignored.
2. **Unknown `v`** — discarded. No migration at v1.
3. **Malformed records** — filtered by `kind`; cursor clamped to `[0, entries.length]`.
4. **IndexedDB unavailable** (private browsing, disabled storage) — every storage operation
   resolves without throwing. No-ops, so the app is simply non-persistent.

## Testing Strategy

**Unit (`serialize.ts`, 100% coverage, node):**
- Round-trips a document byte-identically, including fills and shapes
- Corrupt JSON → null
- Wrong version → null
- Wrong top-level shape → null
- Unknown record `kind` → dropped, others survive
- Cursor clamped to the entry list, at both ends
- Cursor beyond the list after records were dropped

**E2E:**
- Draw → reload → **pixels byte-identical**
- Undo → reload → cursor restored and redo still available
- Background survives reload
- Corrupt stored JSON → app boots clean and still draws
- Clear wipes the save, so a reload comes back empty
- Empty document round-trips

## Boundaries

**Always**
- Write only on commit / undo / redo / background change, debounced
- Validate on the way *in*, never trust the stored payload
- Never let a storage failure reach the drawing path

**Ask first**
- Multiple saved documents
- History compaction (the log grows without bound)
- Export/import of `.paintpad` files
- Any save-format migration

**Never**
- Store raster pixels in the save
- Let `decode` throw

## Success Criteria

1. Draw, reload, and the pixels are byte-identical
2. Undo position survives a reload
3. Background survives a reload
4. Corrupt or oversized saves never prevent the app from starting
5. `npm run test:all` green with no regressions
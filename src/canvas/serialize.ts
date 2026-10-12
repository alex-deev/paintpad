/**
 * Save-format encode and decode — pure and DOM-free, so it runs under `environment: "node"`
 * like every other pure module and is held to 100% coverage.
 *
 * The save is the **command log**, not a raster. Storing pixels would need a separate restore
 * path and would break the invariant that the canvas is always derived from history. Every
 * value here is JSON-safe: a fill stores `{seed, colour, contiguous}` and re-derives itself
 * on replay, which is what lets it survive a round trip at all.
 *
 * The asymmetry that matters: **we never trust what comes back**. `decode` is the untrusted
 * boundary — a hand-edited or truncated save, or one written by a future version, must not
 * be able to crash the app on boot. Every failure path returns null or salvages what it can,
 * because losing one edit is far better than losing the tab.
 */

import type { DocModel } from "./document";
import type { PaintRecord } from "./record";

/** Save-format version. Separate from `DocModel.v` — they change for different reasons. */
export const SAVE_VERSION = 1;

export interface SavedDocument {
  readonly v: number;
  /** Size and raster scale. Restoring keeps a document on the size it was drawn at. */
  readonly doc: DocModel;
  /** The canvas background. A document setting, not an undoable operation. */
  readonly background: string | null;
  /** Every record, including any currently-undone tail. */
  readonly entries: PaintRecord[];
  /** How many of `entries` were live. Restoring this preserves redo across a reload. */
  readonly cursor: number;
}

/**
 * Every record kind `decode` will keep.
 *
 * Anything not listed is DROPPED, silently — a deliberate choice so a malformed save cannot
 * crash replay, but it means adding a record kind requires adding it here too. Miss that and
 * the new kind vanishes on reload while working perfectly in the session. The
 * "keeps every known record kind" test below exists to make that failure loud.
 */
const RECORD_KINDS = ["stroke", "shape", "fill", "clearRect"] as const;

function isRecordKind(value: unknown): boolean {
  return typeof value === "string" && (RECORD_KINDS as readonly string[]).includes(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A record is kept if it is an object with a recognised `kind`.
 *
 * Deliberately shallow. Validating every field would mean duplicating `renderRecord`'s
 * assumptions, and a field this misses fails later and visibly rather than silently — the
 * dangerous case is a record with no usable `kind` at all, which is what this rejects.
 */
function isUsableRecord(value: unknown): value is PaintRecord {
  return isPlainObject(value) && isRecordKind(value.kind);
}

/** A doc model we can actually build a canvas from. */
function isUsableDoc(value: unknown): value is DocModel {
  if (!isPlainObject(value)) return false;
  const { logicalWidth, logicalHeight, rasterScale } = value;
  return (
    Number.isFinite(logicalWidth) &&
    Number.isFinite(logicalHeight) &&
    Number.isFinite(rasterScale) &&
    (logicalWidth as number) > 0 &&
    (logicalHeight as number) > 0 &&
    (rasterScale as number) > 0
  );
}

export function encode(document: SavedDocument): string {
  return JSON.stringify(document);
}

/**
 * Parse a stored save, or return null if it cannot be used.
 *
 * Never throws. A corrupt, truncated, or future-format save yields a clean document rather
 * than a boot failure.
 */
export function decode(raw: string): SavedDocument | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isPlainObject(parsed)) return null;
  if (parsed.v !== SAVE_VERSION) return null;
  if (!isUsableDoc(parsed.doc)) return null;
  if (!Array.isArray(parsed.entries)) return null;
  if (parsed.background !== null && typeof parsed.background !== "string") return null;

  // Salvage rather than reject: one bad record must not cost the whole drawing.
  const entries = parsed.entries.filter(isUsableRecord);

  const rawCursor = parsed.cursor;
  const cursor =
    typeof rawCursor === "number" && Number.isFinite(rawCursor)
      ? Math.min(Math.max(Math.trunc(rawCursor), 0), entries.length)
      : 0;

  return {
    v: SAVE_VERSION,
    doc: parsed.doc,
    background: parsed.background as string | null,
    entries,
    cursor,
  };
}
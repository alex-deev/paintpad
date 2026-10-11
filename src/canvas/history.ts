/**
 * Undo/redo history — pure, DOM-free, and the single source of truth for the document.
 *
 * The canvas is always derived: `visibleEntries(history)` is replayed to produce pixels.
 * History is a value, not a mutable object, so there is exactly one place where state can
 * change and no way for the rendered canvas and the record list to disagree.
 *
 * Note there are deliberately no raster checkpoints here. A full raster at the default
 * document size is ~14.7 MB, and checkpoints go stale the moment history branches — undo
 * truncates the entry list, leaving every later checkpoint describing pixels that no longer
 * exist. The `replayBenchmark` e2e test replays 1,000 records and asserts we stay well
 * inside a frame, so the decision is evidence-backed rather than assumed.
 */

import type { PaintRecord } from "./record";

export interface History {
  /** All recorded operations, including any currently-undone tail. */
  readonly entries: readonly PaintRecord[];
  /** How many of `entries` are currently applied to the canvas. */
  readonly cursor: number;
}

export function createHistory(): History {
  return { entries: [], cursor: 0 };
}

/**
 * Append a committed record.
 *
 * If the cursor is behind the end of `entries` the user has undone and is now drawing
 * something new — that abandoned future is discarded here, in this one operation, so no
 * stale branch can survive into a later replay.
 */
export function push(history: History, record: PaintRecord): History {
  return {
    entries: [...history.entries.slice(0, history.cursor), record],
    cursor: history.cursor + 1,
  };
}

export function undo(history: History): History {
  if (history.cursor === 0) return history;
  return { entries: history.entries, cursor: history.cursor - 1 };
}

export function redo(history: History): History {
  if (history.cursor >= history.entries.length) return history;
  return { entries: history.entries, cursor: history.cursor + 1 };
}

export function canUndo(history: History): boolean {
  return history.cursor > 0;
}

export function canRedo(history: History): boolean {
  return history.cursor < history.entries.length;
}

/** The records that should currently be on the canvas. */
export function visibleEntries(history: History): readonly PaintRecord[] {
  return history.entries.slice(0, history.cursor);
}
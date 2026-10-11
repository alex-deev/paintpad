import { describe, expect, it } from "vitest";
import {
  canRedo,
  canUndo,
  createHistory,
  push,
  redo,
  undo,
  visibleEntries,
} from "../../src/canvas/history";
import type { StrokeRecord } from "../../src/canvas/record";

const stroke = (seed: number): StrokeRecord => ({
  kind: "stroke",
  tool: "pencil",
  composite: "source-over",
  color: "#000000",
  width: 3,
  points: [
    { x: seed, y: seed },
    { x: seed + 10, y: seed + 10 },
  ],
});

const entriesOf = (history: ReturnType<typeof createHistory>) => history.entries.map((r) => r.width);

describe("createHistory", () => {
  it("starts empty with the cursor at the beginning", () => {
    const history = createHistory();
    expect(history.entries).toEqual([]);
    expect(history.cursor).toBe(0);
  });

  it("cannot undo or redo an empty history", () => {
    const history = createHistory();
    expect(canUndo(history)).toBe(false);
    expect(canRedo(history)).toBe(false);
  });
});

describe("push", () => {
  it("appends a record and advances the cursor", () => {
    const history = push(push(createHistory(), stroke(1)), stroke(2));
    expect(history.entries).toHaveLength(2);
    expect(history.cursor).toBe(2);
    expect(canUndo(history)).toBe(true);
    expect(canRedo(history)).toBe(false);
  });

  it("does not mutate the history it was given", () => {
    const before = push(createHistory(), stroke(1));
    const snapshot = structuredClone(before);
    push(before, stroke(2));
    expect(before).toEqual(snapshot);
  });

  it("truncates the redo tail when drawing after an undo", () => {
    // This is the branch case: undo, then draw something new. The old future must be gone,
    // otherwise redo would jump to a state the user abandoned.
    let history = push(push(push(createHistory(), stroke(1)), stroke(2)), stroke(3));
    history = undo(undo(history));
    expect(history.cursor).toBe(1);
    expect(canRedo(history)).toBe(true);

    history = push(history, stroke(4));

    expect(history.entries).toHaveLength(2);
    expect(history.cursor).toBe(2);
    expect(canRedo(history)).toBe(false);
    expect(entriesOf(history)).toEqual([3, 3]);
  });
});

describe("undo", () => {
  it("moves the cursor back without discarding entries", () => {
    let history = push(push(createHistory(), stroke(1)), stroke(2));
    history = undo(history);
    expect(history.cursor).toBe(1);
    expect(history.entries).toHaveLength(2);
    expect(canRedo(history)).toBe(true);
  });

  it("is a no-op at the start of history", () => {
    const empty = createHistory();
    expect(undo(empty)).toEqual(empty);

    const one = push(createHistory(), stroke(1));
    expect(undo(undo(one)).cursor).toBe(0);
  });
});

describe("redo", () => {
  it("moves the cursor forward again", () => {
    let history = push(push(createHistory(), stroke(1)), stroke(2));
    history = undo(undo(history));
    expect(history.cursor).toBe(0);
    expect(canRedo(history)).toBe(true);

    history = redo(history);
    expect(history.cursor).toBe(1);
    expect(canUndo(history)).toBe(true);
  });

  it("is a no-op at the end of history", () => {
    const history = push(push(createHistory(), stroke(1)), stroke(2));
    expect(redo(history).cursor).toBe(2);
  });
});

describe("visibleEntries", () => {
  it("returns only the entries before the cursor", () => {
    let history = push(push(push(createHistory(), stroke(1)), stroke(2)), stroke(3));
    expect(visibleEntries(history)).toHaveLength(3);

    history = undo(undo(history));
    expect(visibleEntries(history)).toHaveLength(1);
    expect(visibleEntries(history)[0]).toBe(history.entries[0]);
  });

  it("returns an empty list when fully undone", () => {
    const history = undo(push(createHistory(), stroke(1)));
    expect(visibleEntries(history)).toEqual([]);
  });
});

describe("history round trip", () => {
  it("undo then redo is lossless across many steps", () => {
    let history = createHistory();
    for (let i = 0; i < 5; i++) history = push(history, stroke(i));

    const peak = history;
    for (let i = 0; i < 5; i++) history = undo(history);
    expect(history.cursor).toBe(0);
    expect(history.entries).toHaveLength(5);

    for (let i = 0; i < 5; i++) history = redo(history);
    expect(history.cursor).toBe(5);
    expect(history.entries).toEqual(peak.entries);
  });

  it("survives an undo/redo cycle many times over without drift", () => {
    let history = push(push(createHistory(), stroke(1)), stroke(2));
    for (let cycle = 0; cycle < 25; cycle++) {
      history = redo(undo(history));
    }
    expect(history.cursor).toBe(2);
    expect(history.entries).toHaveLength(2);
  });
});
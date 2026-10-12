import { describe, expect, it } from "vitest";
import { decode, encode, SAVE_VERSION } from "../../src/canvas/serialize";
import type { PaintRecord } from "../../src/canvas/record";
import { createDoc } from "../../src/canvas/document";

const doc = createDoc(1280, 720, 2);

const stroke: PaintRecord = {
  kind: "stroke",
  tool: "pencil",
  composite: "source-over",
  color: "#c00000",
  width: 6,
  points: [
    { x: 10.5, y: 20.25 },
    { x: 30, y: 40 },
  ],
};

const shape: PaintRecord = {
  kind: "shape",
  shape: "rect",
  from: { x: 5, y: 6 },
  to: { x: 100, y: 120 },
  strokeColor: "#ff0000",
  fillColor: null,
  strokeWidth: 4,
};

const fill: PaintRecord = {
  kind: "fill",
  colour: "#06d6a0",
  seed: { x: 50.25, y: 60.75 },
  contiguous: true,
};

const save = (over: Partial<Parameters<typeof encode>[0]> = {}) => ({
  v: SAVE_VERSION,
  doc,
  background: "#ffffff" as string | null,
  entries: [stroke, shape, fill] as PaintRecord[],
  cursor: 3,
  ...over,
});

describe("encode/decode — round trip", () => {
  it("round-trips a document with every record kind", () => {
    const original = save();
    expect(decode(encode(original))).toEqual(original);
  });

  it("preserves floating point coordinates exactly", () => {
    // Replay derives pixels from these numbers, so any rounding would move them.
    const original = save({
      entries: [{ ...stroke, points: [{ x: 10.123456789, y: -0.987654321 }] }],
      cursor: 1,
    });
    const restored = decode(encode(original))!;
    expect(restored.entries[0]).toEqual(original.entries[0]);
  });

  it("round-trips a transparent background", () => {
    const original = save({ background: null });
    expect(decode(encode(original))!.background).toBeNull();
  });

  it("round-trips an empty document", () => {
    const original = save({ entries: [], cursor: 0 });
    expect(decode(encode(original))).toEqual(original);
  });

  it("round-trips a document with an undone tail", () => {
    // `entries` holds records the user has undone; the cursor says which are live.
    const original = save({ entries: [stroke, shape, fill], cursor: 1 });
    const restored = decode(encode(original))!;
    expect(restored.entries).toHaveLength(3);
    expect(restored.cursor).toBe(1);
  });
});

describe("decode — rejects unusable input", () => {
  const bad = (raw: string) => expect(decode(raw)).toBeNull();

  it("rejects malformed JSON", () => {
    bad("{not json");
    bad("");
    bad("undefined");
  });

  it("rejects JSON that is not an object", () => {
    bad("null");
    bad("42");
    bad('"a string"');
    bad("[]");
  });

  it("rejects an unknown version", () => {
    // No migration at v1: a future format must start clean rather than half-load.
    const raw = JSON.stringify({ ...save(), v: SAVE_VERSION + 1 });
    bad(raw);
    const older = JSON.stringify({ ...save(), v: 0 });
    bad(older);
  });

  it("rejects a missing or malformed doc model", () => {
    bad(JSON.stringify({ ...save(), doc: null }));
    bad(JSON.stringify({ ...save(), doc: "1280x720" }));
    bad(
      JSON.stringify({
        ...save(),
        doc: { v: 1, logicalWidth: 0, logicalHeight: 720, rasterScale: 2 },
      }),
    );
  });

  it("rejects non-array entries", () => {
    bad(JSON.stringify({ ...save(), entries: null }));
    bad(JSON.stringify({ ...save(), entries: { a: 1 } }));
  });

  it("rejects a non-string background that is not null", () => {
    bad(JSON.stringify({ ...save(), background: 42 }));
  });
});

describe("decode — salvages a partially corrupt log", () => {
  it("drops records of unknown kind and keeps the rest", () => {
    // A bad record must not take the whole drawing down with it.
    const raw = JSON.stringify(
      save({ entries: [stroke, { kind: "polygon", points: [] }, shape], cursor: 3 }),
    );
    const restored = decode(raw)!;
    expect(restored.entries).toEqual([stroke, shape]);
  });

  it("drops records that are not objects", () => {
    const raw = JSON.stringify(save({ entries: [stroke, null, "nope", fill], cursor: 4 }));
    const restored = decode(raw)!;
    expect(restored.entries).toEqual([stroke, fill]);
  });

  it("clamps a cursor past the end of the list", () => {
    const raw = JSON.stringify(save({ entries: [stroke], cursor: 99 }));
    expect(decode(raw)!.cursor).toBe(1);
  });

  it("clamps a negative cursor", () => {
    const raw = JSON.stringify(save({ cursor: -5 }));
    expect(decode(raw)!.cursor).toBe(0);
  });

  it("falls back to zero for a missing or non-numeric cursor", () => {
    // A hand-edited or truncated save. Replaying from an unknown position would either
    // throw or show marks the user never left behind.
    for (const cursor of [undefined, null, "3", Number.NaN, Infinity]) {
      const raw = JSON.stringify(save({ cursor: cursor as unknown as number }));
      expect(decode(raw)!.cursor).toBe(0);
    }
  });

  it("clamps the cursor after records were dropped", () => {
    // Cursor 4 against two survivors: replaying entry 4 would throw on an undefined record.
    const raw = JSON.stringify(
      save({ entries: [stroke, { kind: "nope" }, { kind: "nope" }, shape], cursor: 4 }),
    );
    expect(decode(raw)!.cursor).toBe(2);
  });

  it("keeps a null background rather than defaulting it", () => {
    const raw = JSON.stringify(save({ background: null }));
    expect(decode(raw)!.background).toBeNull();
  });
});
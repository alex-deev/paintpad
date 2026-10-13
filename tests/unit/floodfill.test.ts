import { describe, expect, it } from "vitest";
import { floodFill } from "../../src/canvas/floodfill";

/** Build a small RGBA buffer. `0` is transparent, `255` is opaque black. */
function buffer(width: number, height: number): Uint8ClampedArray {
  return new Uint8ClampedArray(width * height * 4);
}

const idx = (width: number, x: number, y: number) => (y * width + x) * 4;
const set = (
  data: Uint8ClampedArray,
  width: number,
  x: number,
  y: number,
  r: number,
  g: number,
  b: number,
  a: number,
) => {
  const i = idx(width, x, y);
  data[i] = r;
  data[i + 1] = g;
  data[i + 2] = b;
  data[i + 3] = a;
};
const alphaAt = (data: Uint8ClampedArray, width: number, x: number, y: number) =>
  data[idx(width, x, y) + 3]!;

const RED = [220, 20, 60, 255] as const;
const BLUE = [30, 80, 220, 255] as const;
const EMPTY = [0, 0, 0, 0] as const;

const options = { contiguous: true, tolerance: 0 };
const globalOptions = { contiguous: false, tolerance: 0 };

describe("floodFill — basic region fill", () => {
  it("fills a transparent region and reports its bounds", () => {
    const w = 10;
    const h = 10;
    const data = buffer(w, h); // all transparent

    const result = floodFill(data, w, h, { x: 3, y: 3 }, RED, options);

    expect(result.changed).toBe(100);
    expect(result.bounds).toEqual({ x: 0, y: 0, width: 10, height: 10 });
    expect(alphaAt(data, w, 3, 3)).toBe(255);
    expect(Array.from(data.slice(idx(w, 0, 0), idx(w, 0, 0) + 4))).toEqual([...RED]);
  });

  it("leaves pixels outside the filled region untouched", () => {
    const w = 8;
    const h = 8;
    const data = buffer(w, h);
    // A solid opaque border enclosing a transparent interior.
    for (let i = 0; i < w; i++) {
      set(data, w, i, 0, 0, 0, 0, 255);
      set(data, w, i, h - 1, 0, 0, 0, 255);
    }
    for (let j = 0; j < h; j++) {
      set(data, w, 0, j, 0, 0, 0, 255);
      set(data, w, w - 1, j, 0, 0, 0, 255);
    }

    const result = floodFill(data, w, h, { x: 3, y: 3 }, RED, options);

    expect(result.changed).toBe((w - 2) * (h - 2));
    expect(alphaAt(data, w, 3, 3)).toBe(255);
    // The border is untouched.
    expect(Array.from(data.slice(idx(w, 0, 0), idx(w, 0, 0) + 4))).toEqual([0, 0, 0, 255]);
  });

  it("reports tighter bounds when the region is smaller than the buffer", () => {
    const w = 20;
    const h = 20;
    const data = buffer(w, h);
    for (let y = 5; y < 10; y++) {
      for (let x = 6; x < 12; x++) set(data, w, x, y, 0, 0, 0, 0);
    }
    // Seed a transparent region enclosed by opaque pixels.
    for (let x = 5; x < 13; x++) {
      set(data, w, x, 4, 0, 0, 0, 255);
      set(data, w, x, 10, 0, 0, 0, 255);
    }
    for (let y = 4; y <= 10; y++) {
      set(data, w, 5, y, 0, 0, 0, 255);
      set(data, w, 12, y, 0, 0, 0, 255);
    }

    const result = floodFill(data, w, h, { x: 8, y: 7 }, RED, options);
    expect(result.bounds).toEqual({ x: 6, y: 5, width: 6, height: 5 });
  });
});

describe("floodFill — does not leak", () => {
  it("does not escape through a diagonal gap in a border", () => {
    // The classic scanline failure: 8-connectivity would squeeze through this corner.
    const w = 6;
    const h = 6;
    const data = buffer(w, h);
    // Opaque everywhere except two transparent cells meeting only at a corner.
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) set(data, w, x, y, 0, 0, 0, 255);
    }
    set(data, w, 1, 1, 0, 0, 0, 0); // interior
    set(data, w, 4, 4, 0, 0, 0, 0); // outside, touching only diagonally
    // Carve a 4-connected path to the border so the outside cell is reachable in principle.
    set(data, w, 3, 4, 0, 0, 0, 0);
    set(data, w, 2, 4, 0, 0, 0, 0);

    const result = floodFill(data, w, h, { x: 1, y: 1 }, RED, options);

    expect(result.changed).toBe(1);
    // The diagonally-adjacent cell must remain untouched.
    expect(alphaAt(data, w, 4, 4)).toBe(0);
    expect(alphaAt(data, w, 1, 1)).toBe(255);
  });

  it("fills only the interior of a 4-connected ring", () => {
    const w = 7;
    const h = 7;
    const data = buffer(w, h);
    for (let i = 0; i < w; i++) {
      set(data, w, i, 0, 0, 0, 0, 255);
      set(data, w, i, 3, 0, 0, 0, 255);
      set(data, w, i, 6, 0, 0, 0, 255);
    }
    for (let j = 0; j < h; j++) {
      set(data, w, 0, j, 0, 0, 0, 255);
      set(data, w, 6, j, 0, 0, 0, 255);
    }

    const result = floodFill(data, w, h, { x: 2, y: 1 }, RED, options);

    // The region between the opaque rows 0 and 3, inside the opaque columns 0 and 6:
    // 2 rows x 5 columns.
    expect(result.changed).toBe(2 * 5);
    expect(alphaAt(data, w, 2, 5)).toBe(0); // below the ring, a separate region, still empty
  });
});

describe("floodFill — colour matching", () => {
  it("includes alpha in the match, so opaque black is not transparent", () => {
    const w = 4;
    const h = 1;
    const data = buffer(w, h);
    set(data, w, 0, 0, 0, 0, 0, 0); // transparent
    set(data, w, 1, 0, 0, 0, 0, 255); // opaque black — same RGB, different alpha

    const result = floodFill(data, w, h, { x: 0, y: 0 }, RED, options);

    // Without alpha in the comparison this would have filled both pixels.
    expect(result.changed).toBe(1);
    expect(alphaAt(data, w, 1, 0)).toBe(255);
    expect(Array.from(data.slice(idx(w, 1, 0), idx(w, 1, 0) + 4))).toEqual([0, 0, 0, 255]);
  });

  it("is a no-op when the replacement matches the target", () => {
    const w = 4;
    const h = 4;
    const data = buffer(w, h);
    const result = floodFill(data, w, h, { x: 1, y: 1 }, EMPTY, options);
    expect(result.changed).toBe(0);
    expect(result.bounds).toBeNull();
  });

  it("tolerance widens the match to near colours", () => {
    const w = 4;
    const h = 1;
    const data = buffer(w, h);
    set(data, w, 0, 0, 100, 100, 100, 255);
    set(data, w, 1, 0, 108, 108, 108, 255); // within tolerance 10
    set(data, w, 2, 0, 200, 200, 200, 255); // far outside

    const result = floodFill(data, w, h, { x: 0, y: 0 }, RED, {
      contiguous: true,
      tolerance: 10,
    });

    expect(result.changed).toBe(2);
    expect(Array.from(data.slice(idx(w, 2, 0), idx(w, 2, 0) + 4))).toEqual([200, 200, 200, 255]);
  });

  it("fills only the exact colour at zero tolerance", () => {
    const w = 4;
    const h = 1;
    const data = buffer(w, h);
    set(data, w, 0, 0, 100, 100, 100, 255);
    set(data, w, 1, 0, 108, 108, 108, 255);

    const result = floodFill(data, w, h, { x: 0, y: 0 }, RED, options);
    expect(result.changed).toBe(1);
  });
});

describe("floodFill — contiguous versus global", () => {
  function twoIslands(w: number, h: number) {
    const data = buffer(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) set(data, w, x, y, 0, 0, 0, 255);
    }
    for (let y = 2; y < 5; y++) {
      for (let x = 2; x < 5; x++) set(data, w, x, y, 0, 0, 0, 0);
    }
    for (let y = 7; y < 10; y++) {
      for (let x = 7; x < 10; x++) set(data, w, x, y, 0, 0, 0, 0);
    }
    return data;
  }

  it("contiguous fills only the connected region", () => {
    const w = 12;
    const h = 12;
    const data = twoIslands(w, h);

    const result = floodFill(data, w, h, { x: 3, y: 3 }, RED, options);

    expect(result.changed).toBe(9);
    expect(alphaAt(data, w, 3, 3)).toBe(255);
    expect(alphaAt(data, w, 8, 8)).toBe(0);
  });

  it("global fills every matching pixel", () => {
    const w = 12;
    const h = 12;
    const data = twoIslands(w, h);

    const result = floodFill(data, w, h, { x: 3, y: 3 }, RED, globalOptions);

    expect(result.changed).toBe(18);
    expect(alphaAt(data, w, 3, 3)).toBe(255);
    expect(alphaAt(data, w, 8, 8)).toBe(255);
  });
});

describe("floodFill — edge cases", () => {
  it("does nothing for a seed outside the buffer", () => {
    const w = 4;
    const h = 4;
    const data = buffer(w, h);

    for (const seed of [
      { x: -1, y: 1 },
      { x: 1, y: -1 },
      { x: 99, y: 1 },
      { x: 1, y: 99 },
    ]) {
      expect(floodFill(data, w, h, seed, RED, options).changed).toBe(0);
    }
  });

  it("fills the whole buffer when every pixel matches", () => {
    const w = 6;
    const h = 6;
    const data = buffer(w, h);
    const result = floodFill(data, w, h, { x: 0, y: 0 }, RED, options);
    expect(result.changed).toBe(36);
  });

  it("handles a 1-pixel-wide region", () => {
    const w = 5;
    const h = 1;
    const data = buffer(w, h);
    const result = floodFill(data, w, h, { x: 2, y: 0 }, RED, options);
    expect(result.changed).toBe(5);
  });

  it(
    "does not recurse: a 2000x2000 region completes without exhausting the stack",
    { timeout: 20_000 },
    () => {
      // A recursive implementation blows the call stack here. This is the regression the
      // design review flagged, so it is worth pinning explicitly.
      //
      // The timeout is generous on purpose. The guard is against *stack exhaustion*, not speed,
      // and a 4M-pixel fill takes a few hundred milliseconds but blows past the default 5s under
      // v8 coverage instrumentation on a loaded machine. A timeout that fires intermittently
      // is worse than no test at all, because it trains you to re-run rather than investigate.
      const w = 2000;
      const h = 2000;
      const data = buffer(w, h);
      const result = floodFill(data, w, h, { x: 1000, y: 1000 }, RED, options);
      expect(result.changed).toBe(2000 * 2000);
      expect(result.bounds).toEqual({ x: 0, y: 0, width: 2000, height: 2000 });
    },
  );

  it("leaves the input untouched when the seed does not match anything replaceable", () => {
    const w = 4;
    const h = 4;
    const data = buffer(w, h);
    for (let i = 0; i < w * h; i++) set(data, w, i % w, Math.floor(i / w), 0, 0, 0, 255);
    const snapshot = data.slice();

    // Seeding on an opaque pixel with an identical replacement colour changes nothing.
    floodFill(data, w, h, { x: 1, y: 1 }, [0, 0, 0, 255], options);
    expect(Array.from(data)).toEqual(Array.from(snapshot));
  });
});

/**
 * Penumbra absorption.
 *
 * Freehand strokes are antialiased, so the edge between the fill and the line is a ramp of
 * partial-alpha pixels. An exact-match fill stops at the first of them, leaving a hairline
 * between the fill and the wall. These pin the absorption that closes it.
 */
describe("floodFill — penumbra absorption", () => {
  const pixelAt = (data: Uint8ClampedArray, w: number, x: number, y: number) =>
    Array.from(data.slice(idx(w, x, y), idx(w, x, y) + 4));

  /** blend(strokeRGB, fillRGB, a/255) — the documented coverage blend. */
  const expected = (stroke: number, fill: number, a: number) =>
    Math.round((stroke * a + fill * (255 - a)) / 255);

  it("absorbs a fringe pixel adjacent to the fill, blended by its coverage", () => {
    const w = 5;
    const h = 1;
    const data = buffer(w, h);
    set(data, w, 1, 0, 0, 0, 0, 128); // half-covered black stroke edge
    set(data, w, 2, 0, 0, 0, 0, 255); // the solid line

    const result = floodFill(data, w, h, { x: 0, y: 0 }, RED, options);

    expect(result.changed).toBe(1);
    expect(result.absorbed).toBe(1);
    // Blended 50/50 between the stroke and the fill, and now fully opaque.
    expect(pixelAt(data, w, 1, 0)).toEqual([
      expected(0, RED[0], 128),
      expected(0, RED[1], 128),
      expected(0, RED[2], 128),
      255,
    ]);
  });

  it("leaves the solid line at full strength", () => {
    const w = 5;
    const h = 1;
    const data = buffer(w, h);
    set(data, w, 1, 0, 0, 0, 0, 128);
    set(data, w, 2, 0, 0, 0, 0, 255);

    floodFill(data, w, h, { x: 0, y: 0 }, RED, options);

    // Absorption stops at opaque pixels, so the outline keeps its full weight.
    expect(pixelAt(data, w, 2, 0)).toEqual([0, 0, 0, 255]);
  });

  it("absorbs a whole multi-pixel ramp, not just the first layer", () => {
    // Shallow-angle edges produce a ramp many pixels wide. One layer would leave it visible.
    const w = 6;
    const h = 1;
    const data = buffer(w, h);
    set(data, w, 1, 0, 0, 0, 0, 50);
    set(data, w, 2, 0, 0, 0, 0, 120);
    set(data, w, 3, 0, 0, 0, 0, 200);
    set(data, w, 4, 0, 0, 0, 0, 255);

    const result = floodFill(data, w, h, { x: 0, y: 0 }, RED, options);

    expect(result.absorbed).toBe(3);
    for (const x of [1, 2, 3]) expect(alphaAt(data, w, x, 0)).toBe(255);
    // Monotonically darker toward the solid line — the blend preserves the gradient.
    expect(pixelAt(data, w, 1, 0)[0]).toBeGreaterThan(pixelAt(data, w, 2, 0)[0]!);
    expect(pixelAt(data, w, 2, 0)[0]).toBeGreaterThan(pixelAt(data, w, 3, 0)[0]!);
  });

  it("does not leak into fully transparent canvas beyond the line", () => {
    const w = 6;
    const h = 1;
    const data = buffer(w, h);
    set(data, w, 1, 0, 0, 0, 0, 128);
    set(data, w, 2, 0, 0, 0, 0, 255);
    // x=3 and x=4 are empty canvas, beyond the opaque line.

    const result = floodFill(data, w, h, { x: 0, y: 0 }, RED, options);

    expect(result.absorbed).toBe(1);
    expect(alphaAt(data, w, 3, 0)).toBe(0);
    expect(alphaAt(data, w, 4, 0)).toBe(0);
  });

  it("does not reach a partial-alpha pixel that the fill never touched", () => {
    // The fill is stopped at x=1, so the run at x=3 is behind an opaque pixel, not adjacent.
    const w = 6;
    const h = 1;
    const data = buffer(w, h);
    set(data, w, 1, 0, 0, 0, 0, 128);
    set(data, w, 2, 0, 0, 0, 0, 255);
    set(data, w, 3, 0, 0, 0, 0, 200);

    const result = floodFill(data, w, h, { x: 0, y: 0 }, RED, options);

    expect(result.absorbed).toBe(1);
    expect(pixelAt(data, w, 3, 0)).toEqual([0, 0, 0, 200]);
  });

  it("grows the dirty bounds to cover absorbed pixels", () => {
    const w = 5;
    const h = 1;
    const data = buffer(w, h);
    set(data, w, 1, 0, 0, 0, 0, 90);
    set(data, w, 2, 0, 0, 0, 0, 255);

    const result = floodFill(data, w, h, { x: 0, y: 0 }, RED, options);

    // Without absorption this would be {x:0, width:1}.
    expect(result.bounds).toEqual({ x: 0, y: 0, width: 2, height: 1 });
  });

  it("absorbs in every direction from a 2D fill", () => {
    const w = 3;
    const h = 3;
    const data = buffer(w, h);
    // Ring of half-alpha pixels around a transparent centre.
    for (const [x, y] of [[0, 1], [2, 1], [1, 0], [1, 2]]) set(data, w, x, y, 0, 0, 0, 128);

    const result = floodFill(data, w, h, { x: 1, y: 1 }, RED, options);

    expect(result.changed).toBe(1);
    expect(result.absorbed).toBe(4);
    for (const [x, y] of [[0, 1], [2, 1], [1, 0], [1, 2]]) {
      expect(alphaAt(data, w, x, y)).toBe(255);
    }
    expect(result.bounds).toEqual({ x: 0, y: 0, width: 3, height: 3 });
  });

  it("absorbs in global mode too", () => {
    // Restricting absorption to contiguous mode would fill the same drawing two different ways.
    const w = 6;
    const h = 1;
    const data = buffer(w, h);
    set(data, w, 1, 0, 0, 0, 0, 128); // touches the fill at x=0 — absorb
    set(data, w, 2, 0, 0, 0, 0, 255); // opaque line
    set(data, w, 3, 0, 0, 0, 0, 200); // behind that line, never touches a fill — leave
    set(data, w, 4, 0, 0, 0, 0, 255); // opaque line

    const result = floodFill(data, w, h, { x: 0, y: 0 }, RED, globalOptions);

    expect(result.changed).toBe(2); // the transparent pixels at x=0 and x=5
    expect(result.absorbed).toBe(1); // only x=1
    expect(alphaAt(data, w, 1, 0)).toBe(255);
    expect(pixelAt(data, w, 3, 0)).toEqual([0, 0, 0, 200]);
  });

  it("absorbs nothing when the fill matched no pixels", () => {
    // Target already equals the fill colour: nothing changed, so there is no boundary to
    // absorb against.
    const w = 3;
    const h = 1;
    const data = buffer(w, h);
    set(data, w, 1, 0, 0, 0, 0, 128);

    const result = floodFill(data, w, h, { x: 0, y: 0 }, [0, 0, 0, 0], options);

    expect(result.changed).toBe(0);
    expect(result.absorbed).toBe(0);
    expect(pixelAt(data, w, 1, 0)).toEqual([0, 0, 0, 128]);
  });
});
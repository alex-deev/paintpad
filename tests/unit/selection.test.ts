import { describe, expect, it } from "vitest";
import { isEmptyRect, normalizeRect, type Rect } from "../../src/canvas/selection";

/**
 * Selection geometry — pure and DOM-free, so it runs under `environment: "node"` like every
 * other pure module and is held to 100% coverage.
 *
 * Everything here works in integer raster pixels, not CSS pixels. Rects reach the canvas
 * through `clearRect`, which is subject to fractional coverage, and a selection that deletes a
 * half-pixel more or less than it showed is the kind of bug that only shows up as "the delete
 * looks slightly off" and never gets reported properly.
 */

describe("normalizeRect — drag directions", () => {
  const expectNormalised = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const forward = normalizeRect(a, b);
    const backward = normalizeRect(b, a);
    // Dragging backwards must select exactly the same region as dragging forwards.
    expect(backward).toEqual(forward);
    return forward;
  };

  it("normalises a top-left to bottom-right drag", () => {
    expect(expectNormalised({ x: 10, y: 20 }, { x: 110, y: 220 })).toEqual({
      x: 10,
      y: 20,
      width: 100,
      height: 200,
    });
  });

  it("normalises a bottom-right to top-left drag", () => {
    expect(expectNormalised({ x: 110, y: 220 }, { x: 10, y: 20 })).toEqual({
      x: 10,
      y: 20,
      width: 100,
      height: 200,
    });
  });

  it("normalises a bottom-left to top-right drag", () => {
    expect(expectNormalised({ x: 10, y: 220 }, { x: 110, y: 20 })).toEqual({
      x: 10,
      y: 20,
      width: 100,
      height: 200,
    });
  });

  it("normalises a top-right to bottom-left drag", () => {
    expect(expectNormalised({ x: 110, y: 20 }, { x: 10, y: 220 })).toEqual({
      x: 10,
      y: 20,
      width: 100,
      height: 200,
    });
  });

  it("handles a negative-coordinate drag", () => {
    // Dragging past the top-left edge. The rect may sit outside the raster; `clearRect`
    // clips it, and the engine rejects empty rects, not out-of-bounds ones.
    expect(normalizeRect({ x: -40, y: -30 }, { x: 20, y: 10 })).toEqual({
      x: -40,
      y: -30,
      width: 60,
      height: 40,
    });
  });
});

describe("normalizeRect — integer snapping", () => {
  it("floors the minimum and ceils the maximum", () => {
    // The drag covered x 10.2..109.8. Rounding would leave the pixels at 10 and 109 outside
    // the selection even though the user drew straight over them.
    expect(normalizeRect({ x: 10.2, y: 20.9 }, { x: 109.8, y: 220.4 })).toEqual({
      x: 10,
      y: 20,
      width: 100,
      height: 201,
    });
  });

  it("keeps an already-aligned drag exact", () => {
    expect(normalizeRect({ x: 10, y: 20 }, { x: 110, y: 220 })).toEqual({
      x: 10,
      y: 20,
      width: 100,
      height: 200,
    });
  });

  it("always covers at least the dragged area", () => {
    const a = { x: 33.3, y: 44.4 };
    const b = { x: 55.5, y: 66.6 };
    const rect = normalizeRect(a, b);
    expect(rect.x).toBeLessThanOrEqual(Math.min(a.x, b.x));
    expect(rect.y).toBeLessThanOrEqual(Math.min(a.y, b.y));
    expect(rect.x + rect.width).toBeGreaterThanOrEqual(Math.max(a.x, b.x));
    expect(rect.y + rect.height).toBeGreaterThanOrEqual(Math.max(a.y, b.y));
  });

  it("treats a zero-length drag on an integer point as empty", () => {
    // A click with no movement. The engine decides intent separately, but the geometry must
    // report nothing selected.
    expect(normalizeRect({ x: 40, y: 40 }, { x: 40, y: 40 })).toEqual({
      x: 40,
      y: 40,
      width: 0,
      height: 0,
    });
  });

  it("covers the single pixel under a fractional zero-length drag", () => {
    expect(normalizeRect({ x: 40.5, y: 40.5 }, { x: 40.5, y: 40.5 })).toEqual({
      x: 40,
      y: 40,
      width: 1,
      height: 1,
    });
  });
});

describe("isEmptyRect", () => {
  const rect = (width: number, height: number): Rect => ({ x: 0, y: 0, width, height });

  it("is empty at zero width or height", () => {
    expect(isEmptyRect(rect(0, 10))).toBe(true);
    expect(isEmptyRect(rect(10, 0))).toBe(true);
    expect(isEmptyRect(rect(0, 0))).toBe(true);
  });

  it("is empty at negative extents", () => {
    // Defence in depth: `normalizeRect` cannot produce these, but a rect arriving from a
    // restored document could, and clearing a negative extent would select backwards.
    expect(isEmptyRect(rect(-5, 10))).toBe(true);
    expect(isEmptyRect(rect(10, -5))).toBe(true);
  });

  it("is not empty at any positive extent", () => {
    expect(isEmptyRect(rect(1, 1))).toBe(false);
    expect(isEmptyRect(rect(100, 200))).toBe(false);
  });

  it("rejects the zero-length click rect", () => {
    expect(isEmptyRect(normalizeRect({ x: 40, y: 40 }, { x: 40, y: 40 }))).toBe(true);
  });
});
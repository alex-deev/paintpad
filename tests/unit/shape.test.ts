import { describe, expect, it } from "vitest";
import {
  isDegenerate,
  normalizeShape,
  shapeBounds,
  SNAP_DEGREES,
} from "../../src/canvas/shape";
import type { ShapeKind } from "../../src/canvas/shape";

const pt = (x: number, y: number) => ({ x, y });

describe("normalizeShape — unconstrained", () => {
  it("passes the drag through unchanged", () => {
    const shape = normalizeShape("rect", pt(10, 20), pt(110, 220), false);
    expect(shape).toEqual({ kind: "rect", from: pt(10, 20), to: pt(110, 220) });
  });

  it("normalises a leftward/upward drag without moving the anchor", () => {
    const shape = normalizeShape("rect", pt(200, 200), pt(50, 40), false);
    expect(shape.from).toEqual(pt(200, 200));
    expect(shape.to).toEqual(pt(50, 40));
  });
});

describe("normalizeShape — line angle snapping", () => {
  it("snaps a shallow line to horizontal", () => {
    const shape = normalizeShape("line", pt(0, 0), pt(100, 8), true);
    expect(shape.to.y).toBe(0);
    expect(shape.to.x).toBeCloseTo(100.32, 1);
  });

  it("snaps to exactly 45 degrees", () => {
    const shape = normalizeShape("line", pt(0, 0), pt(100, 70), true);
    expect(shape.to.x).toBeCloseTo(shape.to.y, 6);
  });

  it("preserves length when snapping", () => {
    const from = pt(10, 10);
    const to = pt(130, 96);
    const before = Math.hypot(to.x - from.x, to.y - from.y);
    const shape = normalizeShape("line", from, to, true);
    const after = Math.hypot(shape.to.x - from.x, shape.to.y - from.y);
    expect(after).toBeCloseTo(before, 6);
  });

  it("snaps only to multiples of the snap angle", () => {
    // A 30-degree drag must land on 45 degrees, not somewhere arbitrary.
    const shape = normalizeShape("line", pt(0, 0), pt(100, 57.7), true);
    const angle = (Math.atan2(shape.to.y, shape.to.x) * 180) / Math.PI;
    expect(angle).toBeCloseTo(SNAP_DEGREES, 6);
  });

  it("snaps a vertical drag to straight down", () => {
    const shape = normalizeShape("line", pt(5, 5), pt(9, 120), true);
    expect(shape.to.x).toBeCloseTo(5, 6);
  });

  it("returns a zero-length line unchanged rather than snapping it", () => {
    // There is no angle to snap, and atan2/hypot of an exact zero are safe but meaningless.
    const shape = normalizeShape("line", pt(7, 7), pt(7, 7), true);
    expect(shape.to).toEqual(pt(7, 7));
  });
});

describe("normalizeShape — square and circle constraints", () => {
  it("makes a wide rectangle into a square", () => {
    const shape = normalizeShape("rect", pt(0, 0), pt(120, 40), true);
    expect(Math.abs(shape.to.x)).toBe(Math.abs(shape.to.y));
  });

  it("makes a tall rectangle into a square", () => {
    const shape = normalizeShape("rect", pt(0, 0), pt(30, 150), true);
    expect(Math.abs(shape.to.x)).toBe(Math.abs(shape.to.y));
  });

  it("makes a wide ellipse into a circle", () => {
    const shape = normalizeShape("ellipse", pt(0, 0), pt(200, 60), true);
    expect(Math.abs(shape.to.x)).toBe(Math.abs(shape.to.y));
  });

  it("constrains an up-left drag correctly", () => {
    const shape = normalizeShape("rect", pt(100, 100), pt(20, 60), true);
    // Both axes extend left and up by the same magnitude.
    expect(shape.from.x - shape.to.x).toBeCloseTo(shape.from.y - shape.to.y, 6);
  });

  it("leaves an already-square shape untouched", () => {
    const shape = normalizeShape("rect", pt(0, 0), pt(80, 80), true);
    expect(shape.to).toEqual(pt(80, 80));
  });

  it("treats an exactly-zero drag axis as no movement on that axis", () => {
    // sign(0) must be 0, not 1 — otherwise a purely vertical drag gains a spurious width.
    const vertical = normalizeShape("rect", pt(0, 0), pt(0, 100), true);
    expect(vertical.to).toEqual(pt(0, 100));

    const horizontal = normalizeShape("ellipse", pt(10, 10), pt(110, 10), true);
    expect(horizontal.to).toEqual(pt(110, 10));
  });
});

describe("isDegenerate", () => {
  it("treats a zero-length line as degenerate", () => {
    expect(isDegenerate({ kind: "line", from: pt(5, 5), to: pt(5, 5) })).toBe(true);
  });

  it("treats a zero-width rectangle as degenerate", () => {
    expect(isDegenerate({ kind: "rect", from: pt(0, 0), to: pt(0, 50) })).toBe(true);
  });

  it("treats a zero-height ellipse as degenerate", () => {
    expect(isDegenerate({ kind: "ellipse", from: pt(0, 0), to: pt(50, 0) })).toBe(true);
  });

  it("accepts a shape with extent on both axes", () => {
    expect(isDegenerate({ kind: "rect", from: pt(0, 0), to: pt(1, 1) })).toBe(false);
    expect(isDegenerate({ kind: "line", from: pt(0, 0), to: pt(0, 1) })).toBe(false);
    expect(isDegenerate({ kind: "ellipse", from: pt(0, 0), to: pt(3, 2) })).toBe(false);
  });

  it("treats a flat ellipse as degenerate, because ry of zero renders nothing", () => {
    // An ellipse has width but no height: ctx.ellipse would receive ry = 0.
    expect(isDegenerate({ kind: "ellipse", from: pt(0, 0), to: pt(3, 0) })).toBe(true);
  });
});

describe("shapeBounds", () => {
  const kinds: ShapeKind[] = ["line", "rect", "ellipse"];

  it("normalises reversed drags to a positive rectangle", () => {
    const bounds = shapeBounds({ kind: "rect", from: pt(120, 90), to: pt(20, 10) });
    expect(bounds).toEqual({ x: 20, y: 10, width: 100, height: 80 });
  });

  it("reports zero size for a degenerate shape", () => {
    for (const kind of kinds) {
      expect(shapeBounds({ kind, from: pt(7, 7), to: pt(7, 7) })).toEqual({
        x: 7,
        y: 7,
        width: 0,
        height: 0,
      });
    }
  });
});
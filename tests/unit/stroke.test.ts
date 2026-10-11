import { describe, expect, it } from "vitest";
import { strokeToOps } from "../../src/canvas/stroke";
import type { Pt } from "../../src/canvas/stroke";

const pt = (x: number, y: number): Pt => ({ x, y });

describe("strokeToOps — degenerate cases", () => {
  it("returns no ops for an empty point list", () => {
    expect(strokeToOps([], 4)).toEqual([]);
  });

  it("emits a single dot for a 1-point stroke (tap)", () => {
    expect(strokeToOps([pt(10, 20)], 4)).toEqual([{ op: "dot", x: 10, y: 20, r: 2 }]);
  });

  it("uses the clamped half-width as the dot radius", () => {
    expect(strokeToOps([pt(0, 0)], 9)).toEqual([{ op: "dot", x: 0, y: 0, r: 4.5 }]);
  });

  it("emits a straight line for exactly 2 points (no stray curve)", () => {
    expect(strokeToOps([pt(0, 0), pt(10, 0)], 2)).toEqual([
      { op: "moveTo", x: 0, y: 0 },
      { op: "lineTo", x: 10, y: 0 },
    ]);
  });

  it("collapses a jitter-only gesture to a single dot", () => {
    const jitter = [pt(5, 5), pt(5.004, 5.004), pt(4.996, 5.001), pt(5.002, 4.997)];
    expect(strokeToOps(jitter, 6)).toEqual([{ op: "dot", x: 5, y: 5, r: 3 }]);
  });
});

describe("strokeToOps — smoothing and tail flush", () => {
  it("emits midpoint quadratics for every interior point", () => {
    const ops = strokeToOps([pt(0, 0), pt(10, 0), pt(20, 0)], 2);
    expect(ops[0]).toEqual({ op: "moveTo", x: 0, y: 0 });
    expect(ops[1]).toEqual({ op: "quadTo", cx: 10, cy: 0, x: 15, y: 0 });
  });

  it("always terminates with a lineTo to the final point (tail flush)", () => {
    const points = [pt(0, 0), pt(5, 5), pt(10, 0), pt(15, 5)];
    const ops = strokeToOps(points, 2);
    const last = ops[ops.length - 1]!;
    expect(last).toEqual({ op: "lineTo", x: 15, y: 5 });
  });

  it("covers the whole path: moveTo + (n-2) quads + lineTo", () => {
    const points = Array.from({ length: 7 }, (_, i) => pt(i * 10, i * i));
    const ops = strokeToOps(points, 3);
    expect(ops.filter((o) => o.op === "quadTo")).toHaveLength(5);
    expect(ops.filter((o) => o.op === "lineTo")).toHaveLength(1);
    expect(ops[0]!.op).toBe("moveTo");
  });

  it("never emits NaN or Infinity, even for extreme input", () => {
    const points = [pt(-1e6, -1e6), pt(1e6, 1e6), pt(0, 0)];
    const ops = strokeToOps(points, 2);
    expect(ops.length).toBeGreaterThan(0);
    for (const op of ops) {
      for (const value of Object.values(op)) {
        if (typeof value === "number") {
          expect(Number.isFinite(value)).toBe(true);
        }
      }
    }
  });
});

describe("strokeToOps — width clamping", () => {
  it("clamps width 0 up to the 1px floor", () => {
    expect(strokeToOps([pt(0, 0)], 0)).toEqual([{ op: "dot", x: 0, y: 0, r: 0.5 }]);
  });

  it("clamps negative widths up to the floor", () => {
    expect(strokeToOps([pt(0, 0)], -50)).toEqual([{ op: "dot", x: 0, y: 0, r: 0.5 }]);
  });

  it("passes sub-pixel widths through the floor rather than emitting a 0px dot", () => {
    const ops = strokeToOps([pt(3, 3)], 0.25);
    expect(ops[0]).toEqual({ op: "dot", x: 3, y: 3, r: 0.5 });
  });
});

describe("strokeToOps — replay identity", () => {
  // The live renderer and the replay renderer must emit the identical op stream,
  // or slice 2's undo will not be byte-exact. Both call this function, so identity
  // is structural; this test pins it.
  it("is deterministic across repeated calls", () => {
    const points = [pt(0, 0), pt(3, 7), pt(11, 2), pt(19, 25), pt(22, 4)];
    expect(strokeToOps(points, 5)).toEqual(strokeToOps(points, 5));
  });

  it("does not mutate the input point list", () => {
    const points = [pt(0, 0), pt(0, 0), pt(5, 5)];
    const snapshot = structuredClone(points);
    strokeToOps(points, 2);
    expect(points).toEqual(snapshot);
  });
});
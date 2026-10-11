/**
 * Shape geometry — pure, DOM-free, and therefore unit-testable under `environment: "node"`.
 *
 * All constraint maths lives here rather than in the engine's pointer handler, so it can be
 * verified without a browser. The engine converts a drag into a `NormalizedShape` and the
 * renderer draws it; neither re-derives the geometry.
 */

import type { Pt } from "./stroke";

export type ShapeKind = "line" | "rect" | "ellipse";

/** Degrees between allowed line angles when constraining. */
export const SNAP_DEGREES = 45;

export interface NormalizedShape {
  readonly kind: ShapeKind;
  readonly from: Pt;
  readonly to: Pt;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Math sign that preserves -0 handling sanely: sign(0) is 0, not 1. */
function sign(value: number): number {
  return value < 0 ? -1 : value > 0 ? 1 : 0;
}

/** Snap a line to the nearest `SNAP_DEGREES` increment while preserving its length. */
function snapLine(from: Pt, to: Pt): Pt {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return to;

  const step = (SNAP_DEGREES * Math.PI) / 180;
  const snapped = Math.round(Math.atan2(dy, dx) / step) * step;
  return {
    x: from.x + Math.cos(snapped) * length,
    y: from.y + Math.sin(snapped) * length,
  };
}

/** Force equal extents on both axes so a rect is square and an ellipse is a circle. */
function makeSquare(from: Pt, to: Pt): Pt {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const magnitude = Math.max(Math.abs(dx), Math.abs(dy));
  return { x: from.x + sign(dx) * magnitude, y: from.y + sign(dy) * magnitude };
}

/**
 * Turn a raw drag into the shape that should actually be drawn, applying the modifier
 * constraint when one is held.
 */
export function normalizeShape(kind: ShapeKind, from: Pt, to: Pt, constrain: boolean): NormalizedShape {
  if (!constrain) return { kind, from, to };
  return { kind, from, to: kind === "line" ? snapLine(from, to) : makeSquare(from, to) };
}

/**
 * Whether a drag produced no shape worth committing. A zero-extent rectangle or ellipse
 * renders as nothing, and a zero-length line renders as a stray dot, so neither is kept.
 */
export function isDegenerate(shape: NormalizedShape): boolean {
  const dx = shape.to.x - shape.from.x;
  const dy = shape.to.y - shape.from.y;
  if (shape.kind === "line") return Math.hypot(dx, dy) === 0;
  return dx === 0 || dy === 0;
}

/** Axis-aligned bounding box, with reversed drags normalised to positive extents. */
export function shapeBounds(shape: NormalizedShape): Rect {
  const x = Math.min(shape.from.x, shape.to.x);
  const y = Math.min(shape.from.y, shape.to.y);
  return {
    x,
    y,
    width: Math.abs(shape.to.x - shape.from.x),
    height: Math.abs(shape.to.y - shape.from.y),
  };
}
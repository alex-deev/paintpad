/**
 * Stroke geometry — pure, DOM-free, and therefore unit-testable under `environment: "node"`.
 *
 * This module emits *data* (`DrawOp[]`), never platform objects like `Path2D`. That keeps
 * the interesting logic testable without a canvas, and guarantees the live renderer and the
 * replay renderer emit an identical op stream — the invariant slice 2's undo depends on.
 */

import { clampStrokeWidth } from "./document";

export interface Pt {
  readonly x: number;
  readonly y: number;
}

export type DrawOp =
  | { readonly op: "moveTo"; readonly x: number; readonly y: number }
  | { readonly op: "quadTo"; readonly cx: number; readonly cy: number; readonly x: number; readonly y: number }
  | { readonly op: "lineTo"; readonly x: number; readonly y: number }
  | { readonly op: "dot"; readonly x: number; readonly y: number; readonly r: number };

/** Points closer than this (in raster units) are treated as the same point. */
const COINCIDENT_EPSILON = 0.01;

function distanceSquared(a: Pt, b: Pt): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function isCoincident(a: Pt, b: Pt): boolean {
  return distanceSquared(a, b) < COINCIDENT_EPSILON * COINCIDENT_EPSILON;
}

/** Drop consecutive duplicate points. Input is never mutated. */
export function dedupe(points: readonly Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const point of points) {
    const previous = out[out.length - 1];
    if (previous === undefined || !isCoincident(previous, point)) {
      out.push(point);
    }
  }
  return out;
}

/**
 * Convert a stroke's raw input samples into a drawable op stream.
 *
 * Interior segments are quadratic Béziers through point midpoints, which turns jittery
 * pointer input into a smooth curve. The final half-segment is emitted explicitly as a
 * `lineTo` — omitting it is what makes naive implementations drop the end of every stroke.
 * A stroke that never moved (a tap) degenerates to an explicit `dot`, because a zero-length
 * subpath with a round cap renders inconsistently across browsers.
 */
export function strokeToOps(points: readonly Pt[], width: number): DrawOp[] {
  const strokeWidth = clampStrokeWidth(width);
  const pts = dedupe(points);

  if (pts.length === 0) return [];

  if (pts.length === 1) {
    const only = pts[0]!;
    return [{ op: "dot", x: only.x, y: only.y, r: strokeWidth / 2 }];
  }

  const first = pts[0]!;
  const ops: DrawOp[] = [{ op: "moveTo", x: first.x, y: first.y }];

  for (let i = 1; i < pts.length - 1; i++) {
    const control = pts[i]!;
    const next = pts[i + 1]!;
    ops.push({
      op: "quadTo",
      cx: control.x,
      cy: control.y,
      x: (control.x + next.x) / 2,
      y: (control.y + next.y) / 2,
    });
  }

  const last = pts[pts.length - 1]!;
  ops.push({ op: "lineTo", x: last.x, y: last.y });

  return ops;
}
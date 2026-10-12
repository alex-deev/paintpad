/**
 * Selection geometry — pure and DOM-free, so it runs under `environment: "node"` like every
 * other pure module and is held to 100% coverage.
 *
 * Everything here works in integer raster pixels. Rects reach the canvas through
 * `clearRect`, which is subject to fractional coverage, and a selection that deletes a
 * half-pixel more or less than it showed is the kind of bug that only ever gets reported as
 * "the delete looks slightly off".
 */

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Pt {
  readonly x: number;
  readonly y: number;
}

/**
 * The rectangle spanned by two drag corners, in integer raster pixels.
 *
 * Floors the minimum and ceils the maximum, so the rect always covers at least the area the
 * user dragged over. Rounding instead would leave the outermost pixels outside a selection the
 * user drew straight through them.
 *
 * The result may extend outside the raster — dragging past the canvas edge is normal, and
 * `clearRect` clips it.
 */
export function normalizeRect(a: Pt, b: Pt): Rect {
  const left = Math.floor(Math.min(a.x, b.x));
  const top = Math.floor(Math.min(a.y, b.y));
  const right = Math.ceil(Math.max(a.x, b.x));
  const bottom = Math.ceil(Math.max(a.y, b.y));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** True when the rect covers no pixels, and so must never become a record. */
export function isEmptyRect(rect: Rect): boolean {
  return rect.width <= 0 || rect.height <= 0;
}

/** True when the point lies inside the rect. Drives move-versus-new-selection. */
export function rectContains(rect: Rect, point: Pt): boolean {
  return (
    point.x >= rect.x &&
    point.x < rect.x + rect.width &&
    point.y >= rect.y &&
    point.y < rect.y + rect.height
  );
}

/**
 * True when two rects overlap.
 *
 * Touching edges do NOT count. Adjacent but non-overlapping rects share no pixels, and
 * treating them as intersecting would drag unrelated records into a move.
 */
export function rectsIntersect(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
  );
}

/** The smallest rect containing both inputs. */
export function unionRect(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return { x, y, width: right - x, height: bottom - y };
}
/**
 * Viewport math — pure, DOM-free.
 *
 * The canvas is centred in the stage and offset by pan. Zoom scales the canvas element's
 * CSS size only; it never touches the backing store. That separation is what keeps strokes
 * resolution-independent.
 */

import type { DocModel } from "./document";
import { rasterHeight, rasterWidth } from "./document";
import type { Pt } from "./stroke";

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 8;

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface Rect extends Size {
  readonly x: number;
  readonly y: number;
}

export interface Viewport {
  readonly zoom: number;
  readonly panX: number;
  readonly panY: number;
}

export const IDENTITY_VIEWPORT: Viewport = { zoom: 1, panX: 0, panY: 0 };

export function clampZoom(zoom: number): number {
  // Only NaN needs the escape hatch. Infinities are still saturating values and should
  // clamp to the nearest bound rather than silently reset to 1:1.
  if (Number.isNaN(zoom)) return 1;
  if (zoom < MIN_ZOOM) return MIN_ZOOM;
  if (zoom > MAX_ZOOM) return MAX_ZOOM;
  return zoom;
}

/** CSS size of the canvas element at the given viewport. */
export function viewportSize(doc: DocModel, viewport: Viewport): Size {
  return {
    width: doc.logicalWidth * viewport.zoom,
    height: doc.logicalHeight * viewport.zoom,
  };
}

/** Top-left of the canvas element relative to the stage, accounting for centring and pan. */
export function canvasOrigin(stageSize: Size, doc: DocModel, viewport: Viewport): Pt {
  const size = viewportSize(doc, viewport);
  return {
    x: (stageSize.width - size.width) / 2 + viewport.panX,
    y: (stageSize.height - size.height) / 2 + viewport.panY,
  };
}

/** Convert a screen-space point (client coordinates) into document raster coordinates. */
export function screenToRaster(
  screen: Pt,
  stageRect: Rect,
  stageSize: Size,
  doc: DocModel,
  viewport: Viewport,
): Pt {
  const origin = canvasOrigin(stageSize, doc, viewport);
  const size = viewportSize(doc, viewport);
  return {
    x: ((screen.x - stageRect.x - origin.x) / size.width) * rasterWidth(doc),
    y: ((screen.y - stageRect.y - origin.y) / size.height) * rasterHeight(doc),
  };
}

/**
 * Return a new viewport zoomed to `nextZoom` while holding the document point currently
 * under `anchor` stationary. Without this, zooming feels like the canvas is being yanked.
 */
export function zoomAtCursor(
  stageRect: Rect,
  stageSize: Size,
  doc: DocModel,
  viewport: Viewport,
  anchor: Pt,
  nextZoom: number,
): Viewport {
  const zoom = clampZoom(nextZoom);
  const before = screenToRaster(anchor, stageRect, stageSize, doc, viewport);

  const nextSize = { width: doc.logicalWidth * zoom, height: doc.logicalHeight * zoom };
  const left = anchor.x - stageRect.x - (before.x / rasterWidth(doc)) * nextSize.width;
  const top = anchor.y - stageRect.y - (before.y / rasterHeight(doc)) * nextSize.height;

  return {
    zoom,
    panX: left - (stageSize.width - nextSize.width) / 2,
    panY: top - (stageSize.height - nextSize.height) / 2,
  };
}
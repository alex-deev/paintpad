/**
 * Document model — the immutable description of a PaintPad canvas.
 *
 * The raster scale is FIXED at document creation and deliberately independent of
 * `devicePixelRatio`. DPR and zoom affect *display only*; the backing store is always
 * logical size x raster scale. This is what makes committed strokes reproduce
 * identically regardless of which monitor the window happens to be on.
 */

export const DOC_VERSION = 1;

/** Backing-store area ceiling. Safari caps canvas area at ~16.7M px and iOS throws
 *  `InvalidStateError` outright beyond it, so we stay well clear. */
export const MAX_CANVAS_AREA = 4096 * 4096;

/** Smallest brush width, in raster units. Below one pixel a stroke vanishes. */
export const MIN_STROKE_WIDTH = 1;

/** Largest brush width, in raster units. */
export const MAX_STROKE_WIDTH = 256;

export const DEFAULT_RASTER_SCALE = 2;

export interface DocModel {
  readonly v: number;
  /** Width in logical (CSS) pixels. */
  readonly logicalWidth: number;
  /** Height in logical (CSS) pixels. */
  readonly logicalHeight: number;
  /** Backing-store pixels per logical pixel. Fixed for the life of the document. */
  readonly rasterScale: number;
}

function assertFinitePositive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`DocModel: ${label} must be a finite positive number, received ${value}`);
  }
}

export function createDoc(
  logicalWidth = 1280,
  logicalHeight = 720,
  rasterScale = DEFAULT_RASTER_SCALE,
): DocModel {
  assertFinitePositive(logicalWidth, "logicalWidth");
  assertFinitePositive(logicalHeight, "logicalHeight");
  assertFinitePositive(rasterScale, "rasterScale");

  const area = logicalWidth * logicalHeight;
  if (area > MAX_CANVAS_AREA) {
    throw new Error(
      `DocModel: area ${area}px exceeds the maximum of ${MAX_CANVAS_AREA}px ` +
        `(${logicalWidth}x${logicalHeight} exceeds ${MAX_CANVAS_AREA}px)`,
    );
  }

  return { v: DOC_VERSION, logicalWidth, logicalHeight, rasterScale };
}

/** Backing-store width in device pixels. This is the drawing surface coordinate space. */
export function rasterWidth(doc: DocModel): number {
  return Math.round(doc.logicalWidth * doc.rasterScale);
}

/** Backing-store height in device pixels. */
export function rasterHeight(doc: DocModel): number {
  return Math.round(doc.logicalHeight * doc.rasterScale);
}

/** Clamp a requested brush width into the drawable range, recovering sanely from NaN. */
export function clampStrokeWidth(width: number): number {
  if (!Number.isFinite(width)) return MIN_STROKE_WIDTH;
  if (width < MIN_STROKE_WIDTH) return MIN_STROKE_WIDTH;
  if (width > MAX_STROKE_WIDTH) return MAX_STROKE_WIDTH;
  return width;
}
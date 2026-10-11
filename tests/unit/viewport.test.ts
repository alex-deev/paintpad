import { describe, expect, it } from "vitest";
import { createDoc } from "../../src/canvas/document";
import {
  clampZoom,
  MAX_ZOOM,
  MIN_ZOOM,
  screenToRaster,
  viewportSize,
  zoomAtCursor,
  type Rect,
  type Size,
} from "../../src/canvas/viewport";

const stageRect: Rect = { x: 0, y: 0, width: 1600, height: 1000 };
const stageSize: Size = { width: 1600, height: 1000 };

const identity = { zoom: 1, panX: 0, panY: 0 };

describe("clampZoom", () => {
  it("clamps to the supported range", () => {
    expect(clampZoom(0.0001)).toBe(MIN_ZOOM);
    expect(clampZoom(1000)).toBe(MAX_ZOOM);
  });

  it("passes in-range values through", () => {
    expect(clampZoom(2.5)).toBe(2.5);
  });

  it("recovers a sane value from non-finite input", () => {
    // A NaN zoom would propagate into the transform matrix and silently blank the canvas.
    expect(clampZoom(Number.NaN)).toBe(1);
    expect(clampZoom(Number.POSITIVE_INFINITY)).toBe(MAX_ZOOM);
    expect(clampZoom(Number.NEGATIVE_INFINITY)).toBe(MIN_ZOOM);
  });
});

describe("viewportSize", () => {
  it("reports CSS size as logical size x zoom", () => {
    const doc = createDoc(1280, 720, 2);
    expect(viewportSize(doc, { ...identity, zoom: 0.5 })).toEqual({ width: 640, height: 360 });
    expect(viewportSize(doc, { ...identity, zoom: 2 })).toEqual({ width: 2560, height: 1440 });
  });

  it("reports zero CSS size when zoom collapses to the floor and the stage is huge", () => {
    const doc = createDoc(100, 100, 1);
    const size = viewportSize(doc, { ...identity, zoom: MIN_ZOOM });
    expect(size.width).toBeGreaterThan(0);
  });
});

describe("screenToRaster", () => {
  const doc = createDoc(1280, 720, 2);

  it("maps the canvas top-left to raster origin", () => {
    // At zoom 1 the canvas is 1280x720 CSS px, centred in a 1600x1000 stage:
    // left = (1600-1280)/2 = 160, top = (1000-720)/2 = 140.
    const p = screenToRaster({ x: 160, y: 140 }, stageRect, stageSize, doc, identity);
    expect(p.x).toBeCloseTo(0, 6);
    expect(p.y).toBeCloseTo(0, 6);
  });

  it("maps the canvas bottom-right to the far raster corner", () => {
    const p = screenToRaster({ x: 160 + 1280, y: 140 + 720 }, stageRect, stageSize, doc, identity);
    expect(p.x).toBeCloseTo(2560, 6);
    expect(p.y).toBeCloseTo(1440, 6);
  });

  it("applies pan as an offset in screen space", () => {
    const panned = { zoom: 1, panX: 50, panY: -20 };
    const a = screenToRaster({ x: 200, y: 200 }, stageRect, stageSize, doc, identity);
    const b = screenToRaster({ x: 250, y: 180 }, stageRect, stageSize, doc, panned);
    expect(b.x).toBeCloseTo(a.x, 6);
    expect(b.y).toBeCloseTo(a.y, 6);
  });

  it("scales correctly at zoom 0.25 and zoom 4", () => {
    for (const zoom of [0.25, 4]) {
      const vp = { ...identity, zoom };
      const css = viewportSize(doc, vp);
      const left = (stageSize.width - css.width) / 2;
      const top = (stageSize.height - css.height) / 2;
      const p = screenToRaster({ x: left + css.width / 2, y: top + css.height / 2 }, stageRect, stageSize, doc, vp);
      expect(p.x).toBeCloseTo(1280, 6);
      expect(p.y).toBeCloseTo(720, 6);
    }
  });

  it("round-trips through the inverse mapping", () => {
    const vp = { zoom: 0.75, panX: -33, panY: 12 };
    const css = viewportSize(doc, vp);
    const left = (stageSize.width - css.width) / 2;
    const raster = screenToRaster({ x: left + 123, y: top0(css) + 45 }, stageRect, stageSize, doc, vp);
    expect(raster.x).toBeGreaterThan(0);
    expect(raster.y).toBeGreaterThan(0);
  });
});

function top0(css: { height: number }): number {
  return (stageSize.height - css.height) / 2;
}

describe("zoomAtCursor", () => {
  const doc = createDoc(1280, 720, 2);

  it("keeps the document point under the cursor fixed", () => {
    const anchor = { x: 400, y: 300 };
    const before = screenToRaster(anchor, stageRect, stageSize, doc, identity);

    const next = zoomAtCursor(stageRect, stageSize, doc, identity, anchor, 2);
    const after = screenToRaster(anchor, stageRect, stageSize, doc, next);

    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it("still holds the anchor when starting from a panned and zoomed state", () => {
    const start = { zoom: 1.5, panX: 80, panY: -45 };
    const anchor = { x: 900, y: 620 };
    const before = screenToRaster(anchor, stageRect, stageSize, doc, start);

    const next = zoomAtCursor(stageRect, stageSize, doc, start, anchor, 0.4);
    const after = screenToRaster(anchor, stageRect, stageSize, doc, next);

    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it("clamps the requested zoom to the supported range", () => {
    expect(zoomAtCursor(stageRect, stageSize, doc, identity, { x: 800, y: 500 }, 999).zoom).toBe(MAX_ZOOM);
    expect(zoomAtCursor(stageRect, stageSize, doc, identity, { x: 800, y: 500 }, 0.0001).zoom).toBe(MIN_ZOOM);
  });
});
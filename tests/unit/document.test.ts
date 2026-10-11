import { describe, expect, it } from "vitest";
import { clampStrokeWidth, createDoc, rasterHeight, rasterWidth } from "../../src/canvas/document";

describe("createDoc", () => {
  it("defaults to 1280x720 at 2x raster scale", () => {
    const doc = createDoc();
    expect(doc).toMatchObject({ v: 1, logicalWidth: 1280, logicalHeight: 720, rasterScale: 2 });
  });

  it("derives the backing store from logical size x raster scale", () => {
    const doc = createDoc(800, 600, 2);
    expect(rasterWidth(doc)).toBe(1600);
    expect(rasterHeight(doc)).toBe(1200);
  });

  it("rejects dimensions that exceed the area cap", () => {
    expect(() => createDoc(4096, 4097)).toThrow(/area/i);
  });

  it("accepts dimensions exactly at the area cap", () => {
    expect(() => createDoc(4096, 4096)).not.toThrow();
  });

  it("rejects zero and negative dimensions", () => {
    expect(() => createDoc(0, 100)).toThrow();
    expect(() => createDoc(100, -1)).toThrow();
  });

  it("rejects non-finite dimensions", () => {
    expect(() => createDoc(Number.NaN, 100)).toThrow();
    expect(() => createDoc(100, Number.POSITIVE_INFINITY)).toThrow();
  });

  it("rejects a non-positive raster scale", () => {
    expect(() => createDoc(100, 100, 0)).toThrow();
    expect(() => createDoc(100, 100, -1)).toThrow();
  });
});

describe("clampStrokeWidth", () => {
  it("enforces a 1px floor so sub-pixel widths never vanish", () => {
    expect(clampStrokeWidth(0)).toBe(1);
    expect(clampStrokeWidth(0.1)).toBe(1);
    expect(clampStrokeWidth(-4)).toBe(1);
  });

  it("passes valid widths through unchanged", () => {
    expect(clampStrokeWidth(4)).toBe(4);
    expect(clampStrokeWidth(64)).toBe(64);
  });

  it("caps at the maximum brush size", () => {
    expect(clampStrokeWidth(10_000)).toBe(256);
  });

  it("recovers a sane value from NaN", () => {
    expect(clampStrokeWidth(Number.NaN)).toBe(1);
  });
});
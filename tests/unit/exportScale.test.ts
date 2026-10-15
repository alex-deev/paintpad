import { describe, expect, it } from "vitest";
import { createDoc } from "../../src/canvas/document";
import { exportDimensions, exportTierLabel } from "../../src/canvas/exportScale";

describe("exportDimensions", () => {
  it("renders the full tier at the document's raster size", () => {
    const doc = createDoc(1280, 720, 2);
    expect(exportDimensions(doc, "full")).toEqual({ width: 2560, height: 1440 });
  });

  it("renders the standard tier at the document's logical size", () => {
    const doc = createDoc(1280, 720, 2);
    expect(exportDimensions(doc, "standard")).toEqual({ width: 1280, height: 720 });
  });

  it("halves the logical size for the small tier", () => {
    const doc = createDoc(1280, 720, 2);
    expect(exportDimensions(doc, "small")).toEqual({ width: 640, height: 360 });
  });

  it("scales both axes for a portrait document", () => {
    const doc = createDoc(720, 1280, 2);
    expect(exportDimensions(doc, "small")).toEqual({ width: 360, height: 640 });
  });

  it("rounds a fractional result to whole pixels", () => {
    const doc = createDoc(333, 217, 1);
    expect(exportDimensions(doc, "small")).toEqual({ width: 167, height: 109 });
  });

  it("never returns a zero-dimension image", () => {
    const doc = createDoc(1, 1, 1);
    expect(exportDimensions(doc, "small")).toEqual({ width: 1, height: 1 });
  });

  it("follows the document rather than a fixed size", () => {
    // A different document must yield different tier sizes — the tiers are not
    // hardcoded pixel counts.
    expect(exportDimensions(createDoc(800, 600, 2), "standard")).toEqual({
      width: 800,
      height: 600,
    });
    expect(exportDimensions(createDoc(800, 600, 2), "full")).toEqual({
      width: 1600,
      height: 1200,
    });
  });
});

describe("exportTierLabel", () => {
  it("joins the dimensions with a multiplication sign", () => {
    expect(exportTierLabel({ width: 1280, height: 720 })).toBe("1280 × 720");
  });
});

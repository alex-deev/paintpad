import { describe, expect, it } from "vitest";
import {
  DEFAULT_PALETTE,
  normalizeHex,
  parseHex,
  readableTextOn,
} from "../../src/canvas/color";

describe("normalizeHex — accepted forms", () => {
  it("passes through a canonical 6-digit hex, lower-casing it", () => {
    expect(normalizeHex("#1f2430")).toBe("#1f2430");
    expect(normalizeHex("#FF0000")).toBe("#ff0000");
  });

  it("accepts a hex without the leading hash", () => {
    expect(normalizeHex("ff0000")).toBe("#ff0000");
  });

  it("expands 3-digit shorthand", () => {
    expect(normalizeHex("#abc")).toBe("#aabbcc");
    expect(normalizeHex("F00")).toBe("#ff0000");
  });

  it("ignores surrounding whitespace", () => {
    expect(normalizeHex("  #1f2430  ")).toBe("#1f2430");
    expect(normalizeHex("\t#abc\n")).toBe("#aabbcc");
  });
});

describe("normalizeHex — rejected forms", () => {
  it("rejects empty and hash-only input", () => {
    expect(normalizeHex("")).toBeNull();
    expect(normalizeHex("#")).toBeNull();
    expect(normalizeHex("   ")).toBeNull();
  });

  it("rejects non-hex characters", () => {
    expect(normalizeHex("#gggggg")).toBeNull();
    expect(normalizeHex("red")).toBeNull();
    expect(normalizeHex("#ff00zz")).toBeNull();
  });

  it("rejects the wrong number of digits", () => {
    expect(normalizeHex("#12345")).toBeNull();
    expect(normalizeHex("#1234567")).toBeNull();
    expect(normalizeHex("#12")).toBeNull();
  });

  it("rejects alpha forms — this build is opaque-only", () => {
    // Allowing these would silently turn documents RGBA and change the eraser and PNG
    // semantics, which is explicitly out of scope.
    expect(normalizeHex("#ff000080")).toBeNull();
    expect(normalizeHex("#f008")).toBeNull();
  });

  it("rejects non-string input defensively", () => {
    expect(normalizeHex(null as unknown as string)).toBeNull();
    expect(normalizeHex(undefined as unknown as string)).toBeNull();
    expect(normalizeHex(42 as unknown as string)).toBeNull();
  });
});

describe("parseHex", () => {
  it("splits a hex into its channels", () => {
    expect(parseHex("#1f2430")).toEqual({ r: 31, g: 36, b: 48 });
    expect(parseHex("#ffffff")).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseHex("#000000")).toEqual({ r: 0, g: 0, b: 0 });
  });

  it("falls back to black for input that is not a valid hex", () => {
    // Defensive: callers are expected to normalise first, but a stray value must not
    // produce NaN channels that silently poison comparisons downstream.
    expect(parseHex("not-a-colour")).toEqual({ r: 0, g: 0, b: 0 });
  });
});

describe("readableTextOn", () => {
  it("uses dark text on light backgrounds", () => {
    expect(readableTextOn("#ffffff")).toBe("#111111");
    expect(readableTextOn("#ffe66d")).toBe("#111111");
  });

  it("uses light text on dark backgrounds", () => {
    expect(readableTextOn("#000000")).toBe("#ffffff");
    expect(readableTextOn("#3a0ca3")).toBe("#ffffff");
  });

  it("flips around the mid-light grey boundary", () => {
    // WCAG luminance of these greys is ~0.32 and ~0.57 respectively, straddling the 0.4
    // crossover.
    expect(readableTextOn("#999999")).toBe("#ffffff");
    expect(readableTextOn("#bbbbbb")).toBe("#111111");
  });
});

describe("DEFAULT_PALETTE", () => {
  it("contains only canonical opaque hex values", () => {
    for (const colour of DEFAULT_PALETTE) {
      expect(normalizeHex(colour)).toBe(colour);
    }
  });

  it("has no duplicates", () => {
    expect(new Set(DEFAULT_PALETTE).size).toBe(DEFAULT_PALETTE.length);
  });

  it("offers a usable spread including both extremes", () => {
    expect(DEFAULT_PALETTE).toContain("#000000");
    expect(DEFAULT_PALETTE).toContain("#ffffff");
  });
});
/**
 * Colour helpers — pure, DOM-free, and therefore unit-testable under `environment: "node"`.
 *
 * This build is deliberately OPAQUE-ONLY. `normalizeHex` rejects any alpha form so a
 * four- or eight-digit value can never quietly turn a document into RGBA, change what the
 * eraser means, or produce a transparent PNG export. Transparency needs its own decision
 * across the document model, not an accident inside a colour picker.
 */

export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

const SHORT_HEX = /^#?([0-9a-f]{3})$/i;
const LONG_HEX = /^#?([0-9a-f]{6})$/i;

/**
 * Canonicalise user input to `#rrggbb`, or return null if it is not an opaque hex colour.
 *
 * Accepts `#abc`, `abc`, `#aabbcc`, any case, and surrounding whitespace.
 */
export function normalizeHex(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;

  const short = SHORT_HEX.exec(trimmed);
  if (short) {
    const [r, g, b] = short[1]!.toLowerCase();
    return `#${r}${r}${g}${g}${b}${b}`;
  }

  const long = LONG_HEX.exec(trimmed);
  if (long) return `#${long[1]!.toLowerCase()}`;

  // Anything else — wrong length, alpha form, named colour, non-hex characters — is out.
  return null;
}

/** Split a canonical hex into channels. Assumes the input already passed `normalizeHex`. */
export function parseHex(hex: string): Rgb {
  const canonical = normalizeHex(hex) ?? "#000000";
  return {
    r: Number.parseInt(canonical.slice(1, 3), 16),
    g: Number.parseInt(canonical.slice(3, 5), 16),
    b: Number.parseInt(canonical.slice(5, 7), 16),
  };
}

/**
 * Pick readable label text for a swatch of the given colour, using the WCAG relative
 * luminance formula rather than a naive channel average.
 */
export function readableTextOn(hex: string): "#ffffff" | "#111111" {
  const { r, g, b } = parseHex(hex);
  const channel = (value: number) => {
    const v = value / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  return luminance > 0.4 ? "#111111" : "#ffffff";
}

/** Curated preset palette. Neutral ramp first, then hue families, then earth tones. */
export const DEFAULT_PALETTE: readonly string[] = [
  "#000000",
  "#404040",
  "#808080",
  "#bfbfbf",
  "#ffffff",
  "#c00000",
  "#ff0000",
  "#ff6b6b",
  "#ffd166",
  "#ffe66d",
  "#06d6a0",
  "#1b9e77",
  "#11845b",
  "#0b7285",
  "#17a2b8",
  "#4cc9f0",
  "#4361ee",
  "#3a0ca3",
  "#7209b7",
  "#f72585",
  "#8b4513",
  "#a0522d",
  "#d2691e",
  "#f4a460",
  "#f5deb3",
];
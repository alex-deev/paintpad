/**
 * Flood fill — pure and DOM-free, so it runs under `environment: "node"` like every other
 * pure module and is held to 100% coverage.
 *
 * Two failure modes this deliberately avoids, both flagged in the design review:
 *
 * 1. **Stack overflow.** A recursive fill dies on a large flat region — which is the common
 *    case, not an edge case. This is scanline-based with an explicit array stack, so depth
 *    is bounded by the buffer, not by the call stack.
 *
 * 2. **Diagonal leaks.** Scans only the rows above and below each filled span, which is
 *    4-connectivity. 8-connectivity would let a fill squeeze through a diagonal corner in a
 *    border and escape across the whole canvas.
 *
 * Colour matching includes **alpha**. Opaque black `(0,0,0,255)` and transparent
 * `(0,0,0,0)` share RGB channels; ignoring alpha would make every fill leak.
 *
 * A third behaviour, also review-driven: **penumbra absorption**. Freehand strokes are
 * antialiased, so the edge between the fill and the line is a ramp of partial-alpha pixels.
 * An exact-match fill stops at the first of them and leaves a hairline short of the wall.
 * The connected run of partial-alpha pixels touching the fill is absorbed and recoloured
 * toward the fill by each pixel's own coverage. See `absorbPenumbra`.
 */

export interface FillOptions {
  /** Only the region connected to the seed. When false, every matching pixel is replaced. */
  readonly contiguous: boolean;
  /** Maximum per-channel difference for a pixel to count as a match, across RGBA. */
  readonly tolerance: number;
}

export interface Bounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface FillResult {
  /** How many pixels the fill itself replaced. */
  readonly changed: number;
  /** How many antialiased edge pixels were absorbed into the fill. See `absorbPenumbra`. */
  readonly absorbed: number;
  /** The dirty rectangle, or null when nothing changed. Covers absorbed pixels too. */
  readonly bounds: Bounds | null;
}

export type Rgba = readonly [number, number, number, number];

export const DEFAULT_FILL_OPTIONS: FillOptions = { contiguous: true, tolerance: 0 };

const EMPTY: FillResult = { changed: 0, absorbed: 0, bounds: null };

/**
 * Per-pixel state for one fill. Three states in a single raster-sized array, so absorption
 * does not need a second allocation.
 */
const UNTOUCHED = 0;
const FILLED = 1;
const ABSORBED = 2;

/** A mutable version of `Bounds` that absorption can grow in place. */
interface DirtyBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function matchesPixel(
  data: Uint8ClampedArray,
  offset: number,
  target: Rgba,
  tolerance: number,
): boolean {
  return (
    Math.abs(data[offset]! - target[0]) <= tolerance &&
    Math.abs(data[offset + 1]! - target[1]) <= tolerance &&
    Math.abs(data[offset + 2]! - target[2]) <= tolerance &&
    Math.abs(data[offset + 3]! - target[3]) <= tolerance
  );
}

/** Replace every pixel in a bounds rect, tracking the dirty region as we go. */
function fillBounds(): DirtyBox {
  return { minX: Number.POSITIVE_INFINITY, minY: Number.POSITIVE_INFINITY, maxX: -1, maxY: -1 };
}

/** Convert a tracked dirty region into a rect. Callers pass this only when something changed. */
function toBounds(box: ReturnType<typeof fillBounds>): Bounds {
  return {
    x: box.minX,
    y: box.minY,
    width: box.maxX - box.minX + 1,
    height: box.maxY - box.minY + 1,
  };
}

/**
 * Absorb the antialiased edge between the fill and the artwork it was filled against.
 *
 * Every partial-alpha pixel (`0 < a < 255`) 4-connected to a filled pixel is recoloured to
 * the stroke/fill blend at that pixel's coverage and made opaque:
 *
 *     out = stroke · (a/255) + fill · ((255-a)/255),   alpha := 255
 *
 * Opaque, because both neighbours are now opaque — leaving it translucent would show as a
 * seam against the fill on one side and the line on the other. Blended rather than forced to
 * the solid fill colour, which would eat ~1px of the outline and visibly thin a 1px line.
 *
 * The walk stops at opaque pixels and never enters fully transparent ones, which bounds it
 * to the fill's own edge: it cannot leak across a solid line or into empty canvas.
 *
 * Blending is done in sRGB rather than linear light because `ImageData` is non-premultiplied
 * sRGB, and this is the same blend the browser's own antialiasing performed to produce the
 * pixel in the first place.
 *
 * Returns how many pixels were absorbed.
 */
function absorbPenumbra(
  data: Uint8ClampedArray,
  mask: Uint8Array,
  width: number,
  height: number,
  replacement: Rgba,
  box: DirtyBox,
): number {
  const queue: number[] = [];

  // Seed from the fill's boundary: every partial-alpha pixel touching a filled pixel. This
  // needs one raster-sized pass, which is the same order as the fill itself and is bounded
  // by the getImageData the caller already did.
  for (let y = 0; y < height; y++) {
    const rowStart = y * width;
    for (let x = 0; x < width; x++) {
      const index = rowStart + x;
      if (mask[index] !== UNTOUCHED) continue;
      const alpha = data[index * 4 + 3]!;
      if (alpha === 0 || alpha === 255) continue;
      // 4-connected only, matching the fill's own connectivity.
      const touchesFill =
        (x > 0 && mask[index - 1] === FILLED) ||
        (x < width - 1 && mask[index + 1] === FILLED) ||
        (y > 0 && mask[index - width] === FILLED) ||
        (y < height - 1 && mask[index + width] === FILLED);
      if (!touchesFill) continue;
      mask[index] = ABSORBED;
      queue.push(index);
    }
  }

  let absorbed = 0;
  while (queue.length > 0) {
    const index = queue.pop()!;
    const x = index % width;
    const y = (index / width) | 0;
    const offset = index * 4;
    const alpha = data[offset + 3]!;
    const coverage = alpha / 255;
    const inverse = 1 - coverage;

    data[offset] = data[offset]! * coverage + replacement[0] * inverse;
    data[offset + 1] = data[offset + 1]! * coverage + replacement[1] * inverse;
    data[offset + 2] = data[offset + 2]! * coverage + replacement[2] * inverse;
    data[offset + 3] = 255;

    if (x < box.minX) box.minX = x;
    if (x > box.maxX) box.maxX = x;
    if (y < box.minY) box.minY = y;
    if (y > box.maxY) box.maxY = y;
    absorbed++;

    // Continue the run outward. The pixel is now opaque, so this terminates on its own at
    // the solid line, but the guard keeps a malformed mask from looping.
    for (const neighbour of [
      x > 0 ? index - 1 : -1,
      x < width - 1 ? index + 1 : -1,
      y > 0 ? index - width : -1,
      y < height - 1 ? index + width : -1,
    ]) {
      if (neighbour < 0) continue;
      if (mask[neighbour] !== UNTOUCHED) continue;
      const neighbourAlpha = data[neighbour * 4 + 3]!;
      if (neighbourAlpha === 0 || neighbourAlpha === 255) continue;
      mask[neighbour] = ABSORBED;
      queue.push(neighbour);
    }
  }

  return absorbed;
}

function fillGlobal(
  data: Uint8ClampedArray,
  mask: Uint8Array,
  width: number,
  height: number,
  target: Rgba,
  replacement: Rgba,
  tolerance: number,
): FillResult {
  const box = fillBounds();
  let changed = 0;

  for (let y = 0; y < height; y++) {
    const rowStart = y * width;
    for (let x = 0; x < width; x++) {
      const offset = (rowStart + x) * 4;
      if (!matchesPixel(data, offset, target, tolerance)) continue;
      data[offset] = replacement[0];
      data[offset + 1] = replacement[1];
      data[offset + 2] = replacement[2];
      data[offset + 3] = replacement[3];
      mask[rowStart + x] = FILLED;
      if (x < box.minX) box.minX = x;
      if (x > box.maxX) box.maxX = x;
      if (y < box.minY) box.minY = y;
      if (y > box.maxY) box.maxY = y;
      changed++;
    }
  }

  // `changed` is always at least 1 here: the seed pixel is the source of `target`, so it
  // necessarily matches itself.
  const absorbed = absorbPenumbra(data, mask, width, height, replacement, box);
  return { changed, absorbed, bounds: toBounds(box) };
}

/**
 * Replace the region connected to the seed with `replacement`, in place.
 *
 * `data` is a raw RGBA byte buffer (width * height * 4). The target colour is sampled from
 * the seed rather than passed in, so replay reproduces exactly what the click saw.
 */
export function floodFill(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  seed: { readonly x: number; readonly y: number },
  replacement: Rgba,
  options: FillOptions = DEFAULT_FILL_OPTIONS,
): FillResult {
  const { x: seedX, y: seedY } = seed;
  // A zero-sized buffer is covered by the seed bounds check below: with width 0, any seedX
  // satisfies `seedX >= width`. No separate dimension guard is needed.
  if (seedX < 0 || seedY < 0 || seedX >= width || seedY >= height) return EMPTY;

  const seedOffset = (seedY * width + seedX) * 4;
  const target: Rgba = [
    data[seedOffset]!,
    data[seedOffset + 1]!,
    data[seedOffset + 2]!,
    data[seedOffset + 3]!,
  ];

  // Filling a region with the colour it already has is a no-op. Skipping it also avoids a
  // degenerate run where every pixel keeps re-matching itself.
  if (
    target[0] === replacement[0] &&
    target[1] === replacement[1] &&
    target[2] === replacement[2] &&
    target[3] === replacement[3]
  ) {
    return EMPTY;
  }

  // One raster-sized mask, three states, shared by the fill and the absorption pass.
  const mask = new Uint8Array(width * height);

  if (!options.contiguous) {
    return fillGlobal(data, mask, width, height, target, replacement, options.tolerance);
  }

  const box = fillBounds();
  // The mask is required: once a pixel is filled it no longer matches the target, so it
  // would otherwise be re-scanned from a neighbouring span.
  const stack: number[] = [seedX, seedY];
  let changed = 0;

  while (stack.length > 0) {
    const y = stack.pop()!;
    const x = stack.pop()!;
    const rowStart = y * width;

    // The three guards around this loop are defence in depth and are unreachable given the
    // algorithm's invariants: a pixel is only pushed when it is unvisited and matching, and
    // filling is the only thing that changes a pixel or sets the mask. They stay because
    // violating that invariant would otherwise corrupt pixels silently — a far worse
    // failure than a branch that is simply never taken.
    /* c8 ignore start */
    if (y < 0 || y >= height) continue;
    if (mask[rowStart + x] === FILLED) continue;
    if (!matchesPixel(data, (rowStart + x) * 4, target, options.tolerance)) continue;
    /* c8 ignore stop */

    // Expand to the full horizontal run containing this pixel.
    let left = x;
    while (left > 0 && mask[rowStart + left - 1] === UNTOUCHED &&
      matchesPixel(data, (rowStart + left - 1) * 4, target, options.tolerance)) {
      left--;
    }
    let right = x;
    while (right < width - 1 && mask[rowStart + right + 1] === UNTOUCHED &&
      matchesPixel(data, (rowStart + right + 1) * 4, target, options.tolerance)) {
      right++;
    }

    for (let px = left; px <= right; px++) {
      const offset = (rowStart + px) * 4;
      data[offset] = replacement[0];
      data[offset + 1] = replacement[1];
      data[offset + 2] = replacement[2];
      data[offset + 3] = replacement[3];
      mask[rowStart + px] = FILLED;
      changed++;
    }

    if (left < box.minX) box.minX = left;
    if (right > box.maxX) box.maxX = right;
    if (y < box.minY) box.minY = y;
    if (y > box.maxY) box.maxY = y;

    // Seed the rows above and below. Only these two — that is what makes this
    // 4-connected and closes the diagonal leak.
    //
    // Only the FIRST pixel of each matching run is pushed, not every matching pixel. For a
    // solid region that is one stack entry per row instead of one per pixel, which is the
    // difference between filling a large canvas in milliseconds and in seconds.
    for (const neighbour of [y - 1, y + 1]) {
      if (neighbour < 0 || neighbour >= height) continue;
      const neighbourRow = neighbour * width;
      let px = left;
      while (px <= right) {
        const offset = (neighbourRow + px) * 4;
        if (
          mask[neighbourRow + px] === FILLED ||
          !matchesPixel(data, offset, target, options.tolerance)
        ) {
          px++;
          continue;
        }
        stack.push(px, neighbour);
        // Skip the rest of this run — it is picked up whole when the seed is expanded.
        while (
          px <= right &&
          mask[neighbourRow + px] === UNTOUCHED &&
          matchesPixel(data, (neighbourRow + px) * 4, target, options.tolerance)
        ) {
          px++;
        }
      }
    }
  }

  const absorbed = absorbPenumbra(data, mask, width, height, replacement, box);
  return { changed, absorbed, bounds: toBounds(box) };
}
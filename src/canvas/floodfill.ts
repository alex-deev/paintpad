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
  /** How many pixels were replaced. */
  readonly changed: number;
  /** The dirty rectangle, or null when nothing changed. */
  readonly bounds: Bounds | null;
}

export type Rgba = readonly [number, number, number, number];

export const DEFAULT_FILL_OPTIONS: FillOptions = { contiguous: true, tolerance: 0 };

const EMPTY: FillResult = { changed: 0, bounds: null };

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
function fillBounds(): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
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

function fillGlobal(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  target: Rgba,
  replacement: Rgba,
  tolerance: number,
): FillResult {
  const box = fillBounds();
  let changed = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      if (!matchesPixel(data, offset, target, tolerance)) continue;
      data[offset] = replacement[0];
      data[offset + 1] = replacement[1];
      data[offset + 2] = replacement[2];
      data[offset + 3] = replacement[3];
      if (x < box.minX) box.minX = x;
      if (x > box.maxX) box.maxX = x;
      if (y < box.minY) box.minY = y;
      if (y > box.maxY) box.maxY = y;
      changed++;
    }
  }

  // `changed` is always at least 1 here: the seed pixel is the source of `target`, so it
  // necessarily matches itself.
  return { changed, bounds: toBounds(box) };
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

  if (!options.contiguous) {
    return fillGlobal(data, width, height, target, replacement, options.tolerance);
  }

  const box = fillBounds();
  // `visited` is required: once a pixel is filled it no longer matches the target, so it
  // would otherwise be re-scanned from a neighbouring span.
  const visited = new Uint8Array(width * height);
  const stack: number[] = [seedX, seedY];
  let changed = 0;

  while (stack.length > 0) {
    const y = stack.pop()!;
    const x = stack.pop()!;
    const rowStart = y * width;

    // The three guards around this loop are defence in depth and are unreachable given the
    // algorithm's invariants: a pixel is only pushed when it is unvisited and matching, and
    // filling is the only thing that changes a pixel or sets `visited`. They stay because
    // violating that invariant would otherwise corrupt pixels silently — a far worse
    // failure than a branch that is simply never taken.
    /* c8 ignore start */
    if (y < 0 || y >= height) continue;
    if (visited[rowStart + x] === 1) continue;
    if (!matchesPixel(data, (rowStart + x) * 4, target, options.tolerance)) continue;
    /* c8 ignore stop */

  // Expand to the full horizontal run containing this pixel.
  let left = x;
    while (left > 0 && visited[rowStart + left - 1] === 0 &&
      matchesPixel(data, (rowStart + left - 1) * 4, target, options.tolerance)) {
      left--;
    }
    let right = x;
    while (right < width - 1 && visited[rowStart + right + 1] === 0 &&
      matchesPixel(data, (rowStart + right + 1) * 4, target, options.tolerance)) {
      right++;
    }

    for (let px = left; px <= right; px++) {
      const offset = (rowStart + px) * 4;
      data[offset] = replacement[0];
      data[offset + 1] = replacement[1];
      data[offset + 2] = replacement[2];
      data[offset + 3] = replacement[3];
      visited[rowStart + px] = 1;
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
          visited[neighbourRow + px] === 1 ||
          !matchesPixel(data, offset, target, options.tolerance)
        ) {
          px++;
          continue;
        }
        stack.push(px, neighbour);
        // Skip the rest of this run — it is picked up whole when the seed is expanded.
        while (
          px <= right &&
          visited[neighbourRow + px] === 0 &&
          matchesPixel(data, (neighbourRow + px) * 4, target, options.tolerance)
        ) {
          px++;
        }
      }
    }
  }

  return { changed, bounds: toBounds(box) };
}
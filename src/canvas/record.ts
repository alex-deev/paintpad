/**
 * Stroke records — the serializable unit of committed drawing.
 *
 * A record must be *self-contained*: a record plus a blank canvas fully determines its
 * output. `renderRecord` therefore sets every piece of context state it reads, inside a
 * save/restore pair, and never inherits ambient state from the caller. Slice 2 replays these
 * to implement undo; keeping them honest now is what makes that replay byte-exact.
 */

import { normalizeHex, parseHex } from "./color";
import { clampStrokeWidth } from "./document";
import { floodFill } from "./floodfill";
import { isDegenerate, shapeBounds, type ShapeKind } from "./shape";
import { rectsIntersect, unionRect, type Rect } from "./selection";
import { strokeToOps, type DrawOp, type Pt } from "./stroke";

/**
 * Exact colour matching. Tolerance is available in `floodFill` and tested there, but is not
 * exposed: a tolerance slider leaks through thin lines, and exact match is what Paint does.
 *
 * Tolerance would not fix the antialiased fringe anyway — a half-alpha edge pixel and a
 * transparent one differ by far more than any usable tolerance.
 */
const FILL_TOLERANCE = 0;

export type ToolId = "pencil" | "eraser" | "line" | "rect" | "ellipse" | "fill" | "select";

/** Tools that accumulate freehand input points rather than dragging an anchor. */
export const FREEHAND_TOOLS: ReadonlySet<ToolId> = new Set<ToolId>(["pencil", "eraser"]);

/** Tools that drag from an anchor to a live endpoint. */
export const SHAPE_TOOLS: ReadonlySet<ToolId> = new Set<ToolId>(["line", "rect", "ellipse"]);

/** Tools that act once on click, with no drag: the bucket. */
export const CLICK_TOOLS: ReadonlySet<ToolId> = new Set<ToolId>(["fill"]);

export function isShapeTool(tool: ToolId): tool is ShapeKind {
  return SHAPE_TOOLS.has(tool);
}

/**
 * How a record combines with what is already on the canvas.
 *
 * `destination-out` is what makes the eraser erase to *nothing* rather than painting a
 * colour over things. Slice 1 reserved this field precisely so that adding real transparency
 * would not require a new record type.
 */
export type CompositeOp = "source-over" | "destination-out";

export interface StrokeRecord {
  readonly kind: "stroke";
  readonly tool: ToolId;
  readonly composite: CompositeOp;
  /** Resolved CSS colour. Stored resolved, not as a palette index, so replay is stable.
   *  Ignored under `destination-out`, where the source alpha is what matters. */
  readonly color: string;
  /** Stroke width in LOGICAL (CSS) pixels, independent of raster scale. */
  readonly width: number;
  readonly points: readonly Pt[];
}

/**
 * A flood fill.
 *
 * Stores PARAMETERS, not the pixels it changed. Replay re-runs the fill against the
 * reconstructed artwork, which is deterministic and — critically — keeps history JSON-safe.
 * Storing the changed `ImageData` would look simpler but `JSON.stringify` silently
 * destroys it, producing an autosave whose undo wipes the document.
 */
export interface FillRecord {
  readonly kind: "fill";
  /** Resolved fill colour, baked at commit time so a later palette change cannot affect it. */
  readonly colour: string;
  /** Seed in raster coordinates. The matched colour is sampled from the canvas at replay. */
  readonly seed: Pt;
  readonly contiguous: boolean;
}

/**
 * Clear a rectangle back to transparency.
 *
 * The first record that is a pixel operation rather than a draw. It is still a *parameter*,
 * which is the whole point: storing the removed `ImageData` would look simpler but
 * `JSON.stringify` destroys it, so any autosaved document containing one would be corrupt.
 * Replaying a rect against the base reproduces the same pixels exactly, at integer
 * coordinates, with no anti-aliasing to reason about.
 */
export interface ClearRectRecord {
  readonly kind: "clearRect";
  /** Integer raster coordinates. */
  readonly rect: Rect;
}

/**
 * Move a rectangular region.
 *
 * The second pixel-shaped record, and the one that settles whether the model generalises. It
 * stores the records that *produced* the region rather than the region's pixels, so history
 * stays JSON-safe and replay stays a re-derivation rather than a lookup.
 *
 * Replay renders the region to a scratch canvas and blits it at an offset. That is not
 * decoration: `applyFill` goes through `getImageData`/`putImageData`, which are
 * transform-independent, so a nested fill would ignore a clip-and-translate on the main
 * context entirely. The scratch canvas *is* the clip, and handles every record kind
 * uniformly.
 */
export interface MoveRecord {
  readonly kind: "move";
  /** Records whose rendering within `clip` is carried to the new position. */
  readonly records: readonly PaintRecord[];
  /** Offset in raster pixels. Integer, so the blit is 1:1 and lossless. */
  readonly dx: number;
  readonly dy: number;
  /** The source region, in integer raster coordinates. Also the area left behind. */
  readonly clip: Rect;
}

/** The union of everything that can appear in history.
 *
 *  Named `PaintRecord` rather than `Record` so it never shadows TypeScript's built-in
 *  `Record<K, V>` utility type in this module's consumers. */
export type PaintRecord =
  | StrokeRecord
  | ShapeRecord
  | FillRecord
  | ClearRectRecord
  | MoveRecord;

export interface ShapeRecord {
  readonly kind: "shape";
  readonly shape: ShapeKind;
  readonly from: Pt;
  readonly to: Pt;
  readonly strokeColor: string;
  /** `null` means outline only. */
  readonly fillColor: string | null;
  /** Outline width in LOGICAL pixels, matching `StrokeRecord.width`. */
  readonly strokeWidth: number;
}

/** Build a Path2D from an op stream. Kept separate so `stroke.ts` stays DOM-free.
 *
 *  Dots are accumulated into a separate path from line work. Filling a combined path would
 *  fill-connect the whole stroke outline; keeping them apart also keeps `stroke()` from
 *  re-stroking the dot subpaths. */
export function toPaths(ops: readonly DrawOp[]): { dots: Path2D; line: Path2D } {
  const dots = new Path2D();
  const line = new Path2D();

  for (const op of ops) {
    if (op.op === "dot") {
      dots.moveTo(op.x + op.r, op.y);
      dots.arc(op.x, op.y, op.r, 0, Math.PI * 2);
      continue;
    }
    if (op.op === "moveTo") line.moveTo(op.x, op.y);
    else if (op.op === "lineTo") line.lineTo(op.x, op.y);
    else if (op.op === "quadTo") line.quadraticCurveTo(op.cx, op.cy, op.x, op.y);
  }

  return { dots, line };
}

/**
 * Paint an op stream. The entire stroke is issued as ONE path and ONE `stroke()` call.
 *
 * This is load-bearing: issuing one `stroke()` per input segment double-composites the
 * antialiased round caps at every joint (`a + b(1-a)`), producing a visible bead per input
 * event — even with a fully opaque colour. Coverage overlap, not colour alpha, is the cause.
 */
function paintOps(ctx: CanvasRenderingContext2D, ops: readonly DrawOp[], color: string, width: number): void {
  const { dots, line } = toPaths(ops);

  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.miterLimit = 10;

  if (dots) ctx.fill(dots);
  if (line) ctx.stroke(line);
}

/**
 * Draw a shape. Self-contained: sets every context property it reads.
 *
 * Ellipses use a single `ctx.ellipse()` call rather than two half-arcs. Two arcs leave a
 * visible seam where they meet and double-antialias the join.
 */
function renderShape(ctx: CanvasRenderingContext2D, record: ShapeRecord, rasterScale: number): void {
  const geometry = { kind: record.shape, from: record.from, to: record.to };
  if (isDegenerate(geometry)) return;

  const bounds = shapeBounds(geometry);
  const cx = bounds.x + bounds.width / 2;
  const cy = bounds.y + bounds.height / 2;
  const rx = bounds.width / 2;
  const ry = bounds.height / 2;

  ctx.strokeStyle = record.strokeColor;
  ctx.fillStyle = record.fillColor ?? record.strokeColor;
  ctx.lineWidth = clampStrokeWidth(record.strokeWidth) * rasterScale;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  ctx.beginPath();
  if (record.shape === "line") {
    ctx.moveTo(record.from.x, record.from.y);
    ctx.lineTo(record.to.x, record.to.y);
  } else if (record.shape === "rect") {
    ctx.rect(bounds.x, bounds.y, bounds.width, bounds.height);
  } else {
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  }

  // Fill before stroke, so the outline sits on top of the fill edge rather than under it.
  if (record.fillColor !== null) ctx.fill();
  if (clampStrokeWidth(record.strokeWidth) > 0) ctx.stroke();
}

/**
 * Apply any record to a raster context.
 *
 * Strokes and shapes draw; fills read and write pixels, so they need their own path. Routing
 * everything through one entry point keeps the engine from needing to know which is which.
 */

/**
 * The area a record can affect, in integer raster pixels, or null if that is unknown.
 *
 * Null means "assume anywhere" and is what keeps a move from silently dropping content. It
 * applies to fills, whose extent depends on the artwork underneath them and cannot be known
 * without replaying the document up to that point.
 */
export function recordBounds(record: PaintRecord, rasterScale: number): Rect | null {
  switch (record.kind) {
    case "clearRect":
      return record.rect;
    case "move": {
      const { clip, dx, dy } = record;
      const target = { x: clip.x + dx, y: clip.y + dy, width: clip.width, height: clip.height };
      // BOTH the source and the destination. A move does two things: it clears `clip` and
      // draws at the target. Reporting only the target meant a later selection over the
      // vacated source filtered this record out, failed to reproduce the clearing, and
      // resurrected the pixels from the nested records — a move that created 14,364 pixels
      // instead of moving any.
      return unionRect(clip, target);
    }
    case "shape": {
      const bounds = shapeBounds({
        kind: record.shape,
        from: record.from,
        to: record.to,
      });
      return bounds === null
        ? null
        : {
            x: Math.floor(bounds.x),
            y: Math.floor(bounds.y),
            // Grown by the stroke width, which extends past the geometric bounds.
            width: Math.ceil(bounds.x + bounds.width) + 2,
            height: Math.ceil(bounds.y + bounds.height) + 2,
          };
    }
    case "stroke": {
      if (record.points.length === 0) return null;
      const half = (clampStrokeWidth(record.width) * rasterScale) / 2;
      let minX = Number.POSITIVE_INFINITY;
      let minY = Number.POSITIVE_INFINITY;
      let maxX = Number.NEGATIVE_INFINITY;
      let maxY = Number.NEGATIVE_INFINITY;
      for (const point of record.points) {
        if (point.x < minX) minX = point.x;
        if (point.y < minY) minY = point.y;
        if (point.x > maxX) maxX = point.x;
        if (point.y > maxY) maxY = point.y;
      }
      return {
        x: Math.floor(minX - half),
        y: Math.floor(minY - half),
        width: Math.ceil(maxX + half) - Math.floor(minX - half),
        height: Math.ceil(maxY + half) - Math.floor(minY - half),
      };
    }
    case "fill":
      return null;
  }
}

/**
 * The records a move of `clip` must carry.
 *
 * Bounds filtering is what stops a long session's history growing multiplicatively: without
 * it every move embeds the entire prior log. Unknown bounds are included, because a region
 * that silently lost a fill would look like a renderer bug rather than a missed record.
 */
export function recordsForMove(
  records: readonly PaintRecord[],
  clip: Rect,
  rasterScale: number,
): PaintRecord[] {
  return records.filter((record) => {
    const bounds = recordBounds(record, rasterScale);
    return bounds === null || rectsIntersect(bounds, clip);
  });
}

/**
 * Scratch surfaces for move replay, indexed by nesting depth.
 *
 * There must be more than one. `applyMove` renders nested records into a scratch surface, and
 * a nested `move` — moving a region that already carries a move — re-enters this function and
 * needs one of its own. Sharing a single canvas resized it mid-render and silently duplicated
 * artwork: moving the same selection twice grew the drawing from 29,561 pixels to 41,588.
 * One canvas per depth bounds allocation by the deepest nesting actually reached, which for
 * a document with no stacked moves is one.
 */
const scratchPool: HTMLCanvasElement[] = [];
let scratchDepth = 0;

function borrowScratch(width: number, height: number): {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
} {
  let canvas = scratchPool[scratchDepth];
  if (!canvas) {
    canvas = document.createElement("canvas");
    scratchPool[scratchDepth] = canvas;
  }
  scratchDepth++;
  // Assigning width/height is the only reliable reset, and it does not happen when the size
  // already matches — hence the explicit clear.
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;

  const ctx = canvas.getContext("2d", { colorSpace: "srgb" });
  if (!ctx) throw new Error("applyMove: could not acquire a 2D context");
  ctx.clearRect(0, 0, width, height);
  // Matters when a nested move blits INTO this surface.
  ctx.imageSmoothingEnabled = false;
  return { canvas, ctx };
}

/**
 * Carry the contents of `clip` by `(dx, dy)`.
 *
 * Clears the source first, so moving a region off itself leaves nothing behind — consistent
 * with delete, and with the background being composited beneath the artwork rather than baked
 * in. Baking the background colour here would reintroduce the frozen-pixel bug.
 *
 * The destination is drawn through whatever transform the caller established. Forcing identity
 * here would be wrong: under a nested replay the destination is the outer move's scratch,
 * which is deliberately translated. Top-level callers establish identity themselves.
 */
function applyMove(ctx: CanvasRenderingContext2D, record: MoveRecord, rasterScale: number): void {
  const { clip, dx, dy, records } = record;
  if (records.length === 0) return;

  const { canvas, ctx: scratchCtx } = borrowScratch(clip.width, clip.height);
  try {
    scratchCtx.save();
    try {
      // Draw the nested records at their ORIGINAL coordinates, shifted so the clip's top-left
      // lands at the origin. Anything outside is cut off by the canvas edge.
      scratchCtx.setTransform(1, 0, 0, 1, -clip.x, -clip.y);
      for (const nested of records) applyRecord(scratchCtx, nested, rasterScale);
    } finally {
      scratchCtx.restore();
    }
  } finally {
    scratchDepth--;
  }

  ctx.save();
  try {
    ctx.clearRect(clip.x, clip.y, clip.width, clip.height);
    // Smoothing off: at integer offsets this is a straight pixel copy, and leaving it on
    // would resample and soften the anti-aliased edge the move was supposed to preserve.
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(canvas, clip.x + dx, clip.y + dy);
    ctx.imageSmoothingEnabled = true;
  } finally {
    ctx.restore();
  }
}

/**
 * Apply any record to a raster context.
 *
 * **Requires an identity transform.** Records are drawn through the destination's current
 * matrix, which is what lets a nested replay inside a move's translated scratch land in the
 * right place. Every top-level caller — `repaintBase` and `paintRecord` — establishes identity
 * before calling, which is where the ghost-pixel protection actually lives; forcing identity
 * here instead would be wrong the moment records nest.
 */
export function applyRecord(
  ctx: CanvasRenderingContext2D,
  record: PaintRecord,
  rasterScale: number,
): void {
  if (record.kind === "fill") {
    applyFill(ctx, record);
    return;
  }
  if (record.kind === "clearRect") {
    applyClearRect(ctx, record);
    return;
  }
  if (record.kind === "move") {
    applyMove(ctx, record, rasterScale);
    return;
  }
  renderRecord(ctx, record, rasterScale);
}

/**
 * Clear a rect on the base, through the destination's current transform.
 *
 * The transform is deliberately NOT forced to identity. Under a nested replay the destination
 * is a move's scratch surface, which is deliberately translated; forcing identity cleared the
 * wrong rectangle, which filled a deleted gap back in and grew the artwork by 8,664 pixels.
 * Every top-level caller establishes identity itself — see `applyRecord`.
 */
function applyClearRect(ctx: CanvasRenderingContext2D, record: ClearRectRecord): void {
  const { rect } = record;
  ctx.save();
  try {
    ctx.clearRect(rect.x, rect.y, rect.width, rect.height);
  } finally {
    ctx.restore();
  }
}

/**
 * Run a fill against the raster.
 *
 * Only the dirty rect is written back — a full `putImageData` would push the entire
 * 15 MB buffer on every fill.
 */
function applyFill(ctx: CanvasRenderingContext2D, record: FillRecord): void {
  const { width, height } = ctx.canvas;
  const seedX = Math.round(record.seed.x);
  const seedY = Math.round(record.seed.y);
  if (seedX < 0 || seedY < 0 || seedX >= width || seedY >= height) return;

  const colour = normalizeHex(record.colour);
  if (!colour) return;
  const { r, g, b } = parseHex(colour);

  const image = ctx.getImageData(0, 0, width, height);
  const result = floodFill(image.data, width, height, { x: seedX, y: seedY }, [r, g, b, 255], {
    contiguous: record.contiguous,
    tolerance: FILL_TOLERANCE,
  });
  if (!result.bounds) return;

  const { x, y, width: w, height: h } = result.bounds;
  ctx.putImageData(image, 0, 0, x, y, w, h);
}

/**
 * Draw any record onto `ctx`. Self-contained: sets all state it reads.
 *
 * `rasterScale` converts the record's logical width into backing-store units. The record
 * stores LOGICAL pixels so that a "1px pencil" is 1px on screen regardless of raster scale;
 * without this conversion a 1px brush is drawn at 0.5px and becomes invisible.
 *
 * The in-progress preview and the committed result call this same function on the same
 * record, so a preview can never differ from what is ultimately drawn.
 */
export function renderRecord(
  ctx: CanvasRenderingContext2D,
  record: PaintRecord,
  rasterScale: number,
): void {
  ctx.save();
  try {
    if (record.kind === "shape") {
      renderShape(ctx, record, rasterScale);
      return;
    }
    // Pixels, not paths — these go through applyRecord instead.
    if (record.kind === "fill" || record.kind === "clearRect" || record.kind === "move") {
      return;
    }
    const ops = strokeToOps(record.points, record.width);
    if (ops.length === 0) return;

    // Set inside the save/restore pair so the composite never leaks to the caller.
    ctx.globalCompositeOperation = record.composite;
    paintOps(ctx, ops, record.color, clampStrokeWidth(record.width) * rasterScale);
  } finally {
    ctx.restore();
  }
}
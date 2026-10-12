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
import type { Rect } from "./selection";
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

/** The union of everything that can appear in history.
 *
 *  Named `PaintRecord` rather than `Record` so it never shadows TypeScript's built-in
 *  `Record<K, V>` utility type in this module's consumers. */
export type PaintRecord = StrokeRecord | ShapeRecord | FillRecord | ClearRectRecord;

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
  renderRecord(ctx, record, rasterScale);
}

/**
 * Clear a rect on the base.
 *
 * The identity transform is set defensively. `clearRect` is subject to the current matrix, so
 * a leftover scale would clear only a fraction of the rect — which is the ghost-pixel bug from
 * the render engine, and the reason this is not just a bare `clearRect` call.
 */
function applyClearRect(ctx: CanvasRenderingContext2D, record: ClearRectRecord): void {
  const { rect } = record;
  ctx.save();
  try {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
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
    if (record.kind === "fill" || record.kind === "clearRect") return;
    const ops = strokeToOps(record.points, record.width);
    if (ops.length === 0) return;

    // Set inside the save/restore pair so the composite never leaks to the caller.
    ctx.globalCompositeOperation = record.composite;
    paintOps(ctx, ops, record.color, clampStrokeWidth(record.width) * rasterScale);
  } finally {
    ctx.restore();
  }
}
/**
 * Stroke records — the serializable unit of committed drawing.
 *
 * A record must be *self-contained*: a record plus a blank canvas fully determines its
 * output. `renderRecord` therefore sets every piece of context state it reads, inside a
 * save/restore pair, and never inherits ambient state from the caller. Slice 2 replays these
 * to implement undo; keeping them honest now is what makes that replay byte-exact.
 */

import { clampStrokeWidth } from "./document";
import { isDegenerate, shapeBounds, type ShapeKind } from "./shape";
import { strokeToOps, type DrawOp, type Pt } from "./stroke";

export type ToolId = "pencil" | "eraser" | "line" | "rect" | "ellipse";

/** Tools that accumulate freehand input points rather than dragging an anchor. */
export const FREEHAND_TOOLS: ReadonlySet<ToolId> = new Set<ToolId>(["pencil", "eraser"]);

/** Tools that drag from an anchor to a live endpoint. */
export const SHAPE_TOOLS: ReadonlySet<ToolId> = new Set<ToolId>(["line", "rect", "ellipse"]);

export function isShapeTool(tool: ToolId): tool is ShapeKind {
  return SHAPE_TOOLS.has(tool);
}

/**
 * Composite mode for the record. Always `source-over` in slice 1 — the eraser paints the
 * background colour rather than punching a hole, which keeps the canvas opaque and avoids
 * the "destination-out against a transparent overlay erases nothing" trap.
 *
 * The field exists now so slice 2 can add real transparency without a record-type change.
 */
export type CompositeOp = "source-over";

export interface StrokeRecord {
  readonly kind: "stroke";
  readonly tool: ToolId;
  readonly composite: CompositeOp;
  /** Resolved CSS colour. Stored resolved, not as a palette index, so replay is stable. */
  readonly color: string;
  /** Stroke width in LOGICAL (CSS) pixels, independent of raster scale. */
  readonly width: number;
  readonly points: readonly Pt[];
}

/** The union of everything that can appear in history.
 *
 *  Named `PaintRecord` rather than `Record` so it never shadows TypeScript's built-in
 *  `Record<K, V>` utility type in this module's consumers. */
export type PaintRecord = StrokeRecord | ShapeRecord;

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
    const ops = strokeToOps(record.points, record.width);
    if (ops.length === 0) return;
    paintOps(ctx, ops, record.color, clampStrokeWidth(record.width) * rasterScale);
  } finally {
    ctx.restore();
  }
}
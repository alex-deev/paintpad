/**
 * Render engine — owns the canvas stack, the gesture lifecycle, and the commit boundary.
 *
 * Layer model:
 *   base    — committed pixels only. Never redrawn except on commit and on reset.
 *   overlay — the in-progress stroke. Cleared and rebuilt every frame.
 *   view    — the single VISIBLE canvas. Each dirty frame it composites base under overlay
 *             *in canvas*, rather than stacking two elements with CSS.
 *
 * Why composite in canvas: CSS stacking hands the blend to the compositor, which blends in
 * its own layer space (affected by `colorSpace`, layer promotion, and any future CSS
 * `opacity`/`filter`). A translucent stroke would then look different while being drawn than
 * after commit — a visible pop on pointerup. Compositing ourselves removes the divergence.
 */

import { normalizeHex } from "./color";
import { clampStrokeWidth, createDoc, rasterHeight, rasterWidth, type DocModel } from "./document";
import {
  canRedo as historyCanRedo,
  canUndo as historyCanUndo,
  createHistory,
  push,
  redo as historyRedo,
  undo as historyUndo,
  visibleEntries,
  type History,
} from "./history";
import {
  FREEHAND_TOOLS,
  isShapeTool,
  renderRecord,
  type PaintRecord,
  type ShapeRecord,
  type StrokeRecord,
  type ToolId,
} from "./record";
import { isDegenerate, normalizeShape, type ShapeKind } from "./shape";
import type { Pt } from "./stroke";
import {
  canvasOrigin,
  clampZoom,
  IDENTITY_VIEWPORT,
  screenToRaster,
  viewportSize,
  zoomAtCursor,
  type Size,
  type Viewport,
} from "./viewport";

export const DEFAULT_FOREGROUND = "#1f2430";
/**
 * The canvas background. `null` means transparent — the default — rather than an opaque
 * colour, so a new document is genuinely empty and PNG export carries real alpha.
 *
 * The eraser restores this: with no background it erases to transparency, and with one set
 * it paints that colour back, which is what someone means by "background colour".
 */
export type CanvasBackground = string | null;

interface StageGeometry {
  readonly rect: DOMRectReadOnly;
  readonly size: Size;
}

/**
 * Whether a keyboard event originated in something the user is typing into.
 *
 * Text fields own their undo stack. Widgets like a range slider or checkbox do not — they
 * must not swallow shortcuts, or using the size control would silently disable the whole
 * keyboard layer until focus moved elsewhere.
 */
function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLInputElement) {
    return !NON_TEXT_INPUT_TYPES.has(target.type);
  }
  return false;
}

/** Whether the record currently in progress is an erase, which cannot be previewed on the
 *  additive overlay. Shape records are always additive. */
function isEraseInProgress(record: PaintRecord | null): record is StrokeRecord {
  return record !== null && record.kind === "stroke" && record.composite === "destination-out";
}

const NON_TEXT_INPUT_TYPES = new Set([
  "range",
  "checkbox",
  "radio",
  "button",
  "submit",
  "reset",
  "color",
  "file",
  "image",
]);

export interface EngineSettings {
  readonly tool: ToolId;
  readonly foreground: string;
  readonly background: CanvasBackground;
  readonly width: number;
  readonly viewport: Viewport;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly recordCount: number;
  readonly fillShapes: boolean;
}

export class Engine {
  readonly doc: DocModel;

  /**
   * The single source of truth for the document. The canvas is always derived by replaying
   * `visibleEntries(history)` — never the other way round.
   */
  private history: History = createHistory();

  private view: HTMLCanvasElement | null = null;
  private base: HTMLCanvasElement | null = null;
  private overlay: HTMLCanvasElement | null = null;

  private viewCtx: CanvasRenderingContext2D | null = null;
  private baseCtx: CanvasRenderingContext2D | null = null;
  private overlayCtx: CanvasRenderingContext2D | null = null;

  private viewport: Viewport = IDENTITY_VIEWPORT;
  private tool: ToolId = "pencil";
  private foreground = DEFAULT_FOREGROUND;
  private background: CanvasBackground = null;
  private width = 4;

  private stage: StageGeometry | null = null;
  private stageElement: HTMLElement | null = null;
  private snapshot: EngineSettings = {
    tool: "pencil",
    foreground: DEFAULT_FOREGROUND,
    background: null,
    width: 4,
    viewport: IDENTITY_VIEWPORT,
    canUndo: false,
    canRedo: false,
    recordCount: 0,
    fillShapes: false,
  };
  private activePointerId: number | null = null;
  private panPointerId: number | null = null;
  private lastPan: Pt | null = null;
  private spaceHeld = false;
  private current: PaintRecord | null = null;
  private anchor: Pt | null = null;
  private constrain = false;
  private fillShapes = false;
  /** Once the user zooms, stop auto-fitting on stage resize. */
  private userAdjustedZoom = false;
  private frame: number | null = null;
  private dprMediaQuery: MediaQueryList | null = null;
  private readonly onDprChange = () => {
    this.bindDevicePixelRatio();
    this.relayout();
  };
  private readonly listeners = new Set<(settings: EngineSettings) => void>();

  constructor(doc: DocModel = createDoc()) {
    this.doc = doc;
  }

  // ─── lifecycle ────────────────────────────────────────────────────────────────

  attach(view: HTMLCanvasElement, stage: HTMLElement): void {
    this.detach();

    const base = document.createElement("canvas");
    const overlay = document.createElement("canvas");

    // Pin the colour space explicitly. Leaving it to the browser reintroduces exactly the
    // blend divergence the in-canvas compositor exists to prevent.
    const viewCtx = view.getContext("2d", { colorSpace: "srgb" });
    const baseCtx = base.getContext("2d", { colorSpace: "srgb" });
    const overlayCtx = overlay.getContext("2d", { colorSpace: "srgb" });
    if (!viewCtx || !baseCtx || !overlayCtx) {
      throw new Error("Engine: could not acquire a 2D context");
    }

    this.view = view;
    this.base = base;
    this.overlay = overlay;
    this.viewCtx = viewCtx;
    this.baseCtx = baseCtx;
    this.overlayCtx = overlayCtx;

    base.width = rasterWidth(this.doc);
    base.height = rasterHeight(this.doc);
    overlay.width = base.width;
    overlay.height = base.height;

    this.reset();

    view.style.position = "absolute";
    view.style.touchAction = "none";

    view.addEventListener("pointerdown", this.handlePointerDown);
    view.addEventListener("pointermove", this.handlePointerMove);
    view.addEventListener("pointerup", this.handlePointerUp);
    view.addEventListener("pointercancel", this.handlePointerUp);
    view.addEventListener("lostpointercapture", this.handlePointerUp);
    view.addEventListener("wheel", this.handleWheel, { passive: false });
    view.addEventListener("contextmenu", this.preventContextMenu);
    stage.addEventListener("pointermove", this.handleStageHover);
    window.addEventListener("keydown", this.handleKeyDown);
    window.addEventListener("keyup", this.handleKeyUp);
    window.addEventListener("keydown", this.handleModifierChange);
    window.addEventListener("keyup", this.handleModifierChange);

    this.stageElement = stage;
    this.stage = { rect: stage.getBoundingClientRect(), size: this.measure(stage) };
    this.fitToStage();
    this.bindDevicePixelRatio();
    this.relayout();
  }

  /**
   * Zoom so the whole document fits inside the stage (never magnifying past 1:1).
   *
   * This is not just convenience. The stage clips with `overflow: hidden`, so a canvas
   * taller than the stage is visually AND hit-test truncated, while `getBoundingClientRect()`
   * still reports its full unclipped box. Drawing into the clipped region silently hits the
   * page behind the canvas instead. Fitting on attach keeps the canvas fully inside its
   * stage, which keeps pointer coordinates honest.
   */
  fitToStage(): void {
    const stage = this.stage;
    if (!stage || stage.size.width <= 0 || stage.size.height <= 0) return;

    const fit = Math.min(
      stage.size.width / this.doc.logicalWidth,
      stage.size.height / this.doc.logicalHeight,
      1,
    );
    this.viewport = { ...this.viewport, zoom: clampZoom(fit) };
    // An explicit Fit hands zoom control back to the stage, so later resizes keep fitting.
    this.userAdjustedZoom = false;
    this.refreshSnapshot();
    this.relayout();
    this.emit();
  }

  detach(): void {
    const view = this.view;
    if (view) {
      view.removeEventListener("pointerdown", this.handlePointerDown);
      view.removeEventListener("pointermove", this.handlePointerMove);
      view.removeEventListener("pointerup", this.handlePointerUp);
      view.removeEventListener("pointercancel", this.handlePointerUp);
      view.removeEventListener("lostpointercapture", this.handlePointerUp);
      view.removeEventListener("wheel", this.handleWheel);
      view.removeEventListener("contextmenu", this.preventContextMenu);
    }
    window.removeEventListener("keydown", this.handleKeyDown);
    window.removeEventListener("keyup", this.handleKeyUp);
    window.removeEventListener("keydown", this.handleModifierChange);
    window.removeEventListener("keyup", this.handleModifierChange);
    this.stageElement?.removeEventListener("pointermove", this.handleStageHover);
    this.stageElement = null;
    this.dprMediaQuery?.removeEventListener("change", this.onDprChange);
    this.dprMediaQuery = null;

    if (this.frame !== null) {
      cancelAnimationFrame(this.frame);
      this.frame = null;
    }

    this.view = null;
    this.base = null;
    this.overlay = null;
    this.viewCtx = null;
    this.baseCtx = null;
    this.overlayCtx = null;
    this.stage = null;
    this.activePointerId = null;
    this.panPointerId = null;
    this.current = null;
    this.anchor = null;
  }

  private measure(stage: HTMLElement): Size {
    return { width: stage.clientWidth, height: stage.clientHeight };
  }

  setStageSize(size: Size): void {
    if (!this.stage) return;
    this.stage = { rect: this.stage.rect, size };
    // Keep fitting to the stage until the user takes control of the zoom. Without this, a
    // boot where the stage has no size yet leaves the canvas at 1:1, positioned far above
    // the viewport and clipped away — drawing then silently lands nowhere.
    if (!this.userAdjustedZoom) this.fitToStage();
    else this.relayout();
  }

  private bindDevicePixelRatio(): void {
    this.dprMediaQuery?.removeEventListener("change", this.onDprChange);
    this.dprMediaQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    this.dprMediaQuery.addEventListener("change", this.onDprChange);
  }

  // ─── settings ─────────────────────────────────────────────────────────────────

  subscribe(listener: (settings: EngineSettings) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * MUST return a referentially stable snapshot. `useSyncExternalStore` compares the
   * result by identity and re-renders forever if a fresh object is minted on every call.
   */
  settings(): EngineSettings {
    return this.snapshot;
  }

  private refreshSnapshot(): void {
    this.snapshot = {
      tool: this.tool,
      foreground: this.foreground,
      background: this.background,
      width: this.width,
      viewport: this.viewport,
      canUndo: historyCanUndo(this.history),
      canRedo: historyCanRedo(this.history),
      recordCount: this.history.entries.length,
      fillShapes: this.fillShapes,
    };
  }

  private emit(): void {
    this.refreshSnapshot();
    const next = this.snapshot;
    for (const listener of this.listeners) listener(next);
  }

  setTool(tool: ToolId): void {
    if (this.tool === tool) return;
    this.tool = tool;
    this.emit();
    this.applyCursor();
  }

  setWidth(width: number): void {
    const next = clampStrokeWidth(width);
    if (this.width === next) return;
    this.width = next;
    this.emit();
    this.applyCursor();
  }

  /**
   * Set the drawing colour. Input is normalised here rather than trusted from the UI, so a
   * malformed value can never be baked into a record where it would poison every replay.
   */
  setForeground(color: string): void {
    const next = normalizeHex(color);
    if (!next || next === this.foreground) return;
    this.foreground = next;
    this.emit();
  }

  /**
   * Set the canvas background. Pass `null` for a transparent document.
   *
   * This is a document *property*, not a mark: it is deliberately not an undoable operation,
   * the same way canvas size is not. Undo removes things you drew, not document settings.
   */
  setBackground(colour: CanvasBackground): void {
    const next = colour === null ? null : normalizeHex(colour);
    if (next === null && colour !== null) return; // invalid input leaves state untouched
    if (next === this.background) return;
    this.background = next;
    // No repaint. The background is not in the raster, so changing it is just a different
    // fill at composite time — O(1) instead of replaying every record.
    this.refreshSnapshot();
    this.requestRender();
    this.emit();
  }

  /** Exchange the drawing colour and the canvas background. */
  swapColors(): void {
    // Swapping a colour with "nothing" is meaningless, so it is a no-op when unset.
    if (this.background === null) return;
    const previous = this.foreground;
    this.foreground = this.background;
    this.background = previous;
    this.emit();
  }

  /** When on, shapes are filled with the foreground colour as well as outlined. */
  setFillShapes(fill: boolean): void {
    if (this.fillShapes === fill) return;
    this.fillShapes = fill;
    this.emit();
  }

  // ─── viewport ─────────────────────────────────────────────────────────────────

  setZoom(zoom: number): void {
    if (!this.stage) return;
    this.userAdjustedZoom = true;
    const anchor = {
      x: this.stage.rect.x + this.stage.size.width / 2,
      y: this.stage.rect.y + this.stage.size.height / 2,
    };
    this.viewport = zoomAtCursor(
      this.stage.rect,
      this.stage.size,
      this.doc,
      this.viewport,
      anchor,
      zoom,
    );
    this.relayout();
    this.emit();
  }

  panBy(dx: number, dy: number): void {
    this.viewport = {
      ...this.viewport,
      panX: this.viewport.panX + dx,
      panY: this.viewport.panY + dy,
    };
    // Pan does not change the zoom readout, so refresh the snapshot without notifying.
    this.refreshSnapshot();
    this.relayout();
  }

  /** Position and size the canvas element for the current viewport, then redraw. */
  private relayout(): void {
    const view = this.view;
    const stage = this.stage;
    if (!view || !stage) return;

    const css = viewportSize(this.doc, this.viewport);
    const origin = canvasOrigin(stage.size, this.doc, this.viewport);
    const dpr = window.devicePixelRatio || 1;

    view.style.left = `${origin.x}px`;
    view.style.top = `${origin.y}px`;
    view.style.width = `${css.width}px`;
    view.style.height = `${css.height}px`;

    const w = Math.max(1, Math.round(css.width * dpr));
    const h = Math.max(1, Math.round(css.height * dpr));
    if (view.width !== w || view.height !== h) {
      view.width = w;
      view.height = h;
    }

    this.requestRender();
  }

  // ─── rendering ────────────────────────────────────────────────────────────────

  private requestRender(): void {
    if (this.frame !== null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.render();
    });
  }

  private render(): void {
    const viewCtx = this.viewCtx;
    const base = this.base;
    const overlay = this.overlay;
    const view = this.view;
    if (!viewCtx || !base || !overlay || !view) return;

    viewCtx.save();
    try {
      // Identity transform before clearing: `clearRect` is subject to the current matrix,
      // so a leftover scale would clear only a fraction of the surface and leave ghosts.
      viewCtx.setTransform(1, 0, 0, 1, 0, 0);
      viewCtx.clearRect(0, 0, view.width, view.height);

      // The background is composited BENEATH the artwork rather than stored inside it.
      // That is what lets a later background change flow through to erased regions: those
      // regions hold no pixels of their own, so there is nothing stale to repaint.
      if (this.background !== null) {
        viewCtx.fillStyle = this.background;
        viewCtx.fillRect(0, 0, view.width, view.height);
      }

      viewCtx.drawImage(base, 0, 0, view.width, view.height);
      viewCtx.drawImage(overlay, 0, 0, view.width, view.height);

      // The in-progress erase is applied last, directly on the view.
      //
      // Preview and commit may use different mechanisms as long as they agree visually:
      // with a background set, punching through on the view would remove the background
      // too, so the preview paints the background colour into the erased region instead —
      // which is exactly what the committed destination-out will reveal. With no background,
      // destination-out is correct and shows the checkerboard.
      if (isEraseInProgress(this.current)) {
        const scale = view.width / base.width;
        viewCtx.setTransform(scale, 0, 0, scale, 0, 0);
        const preview =
          this.background === null
            ? this.current
            : { ...this.current, composite: "source-over" as const, color: this.background };
        renderRecord(viewCtx, preview, this.doc.rasterScale);
      }
    } finally {
      viewCtx.restore();
    }
  }

  private paintOverlay(): void {
    const ctx = this.overlayCtx;
    const overlay = this.overlay;
    if (!ctx || !overlay) return;

    ctx.save();
    try {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, overlay.width, overlay.height);
      // Erases are NOT drawn here. The overlay is additive; a destination-out pass against
      // a transparent layer would remove nothing. They are composited onto the view instead.
      if (this.current && !isEraseInProgress(this.current)) {
        renderRecord(ctx, this.current, this.doc.rasterScale);
      }
    } finally {
      ctx.restore();
    }
  }

  /**
   * "Clear" discards the document and its history. Deliberately NOT undoable — the
   * equivalent of Paint's "New".
   */
  reset(): void {
    this.history = createHistory();
    this.repaintBase();
    this.requestRender();
    this.emit();
  }

  /**
   * The commit boundary. Every gesture funnels through here: the record goes into history
   * (the source of truth) and is then rasterised onto the base canvas.
   */
  private commit(record: PaintRecord): void {
    const next = push(this.history, record);
    const branched = next.entries.length !== this.history.entries.length + 1;

    this.history = next;

    // Pushing while the cursor was behind the end discards the abandoned future. The base
    // canvas still holds those pixels, so it must be rebuilt rather than merely appended to.
    if (branched) this.repaintBase();
    else this.paintRecord(record);

    this.clearOverlay();
    this.requestRender();
    this.emit();
  }

  private paintRecord(record: PaintRecord): void {
    const ctx = this.baseCtx;
    if (!ctx) return;
    ctx.save();
    try {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      renderRecord(ctx, record, this.doc.rasterScale);
    } finally {
      ctx.restore();
    }
  }

  /**
   * Rebuild the base canvas from scratch by replaying history. This is the ONLY path that
   * produces document pixels from records — undo, redo, branching, and `loadRecords` all
   * go through here, so live drawing and replay can never drift apart.
   */
  private repaintBase(): void {
    const ctx = this.baseCtx;
    const base = this.base;
    if (!ctx || !base) return;
    ctx.save();
    try {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      // `base` holds ARTWORK ONLY. The background is deliberately NOT filled in here: if it
      // were baked into the raster, the eraser (which removes artwork) would leave a frozen
      // copy of whatever the background was at erase time, which then fails to repaint.
      // Keeping it out means an erased region is genuinely absent artwork and the
      // background shows through, now and after any later background change.
      ctx.clearRect(0, 0, base.width, base.height);
      for (const record of visibleEntries(this.history)) {
        renderRecord(ctx, record, this.doc.rasterScale);
      }
    } finally {
      ctx.restore();
    }
  }

  // ─── history ──────────────────────────────────────────────────────────────────

  undo(): void {
    const next = historyUndo(this.history);
    if (next === this.history) return;
    this.history = next;
    this.repaintBase();
    this.clearOverlay();
    this.requestRender();
    this.emit();
  }

  redo(): void {
    const next = historyRedo(this.history);
    if (next === this.history) return;
    this.history = next;
    this.repaintBase();
    this.clearOverlay();
    this.requestRender();
    this.emit();
  }

  canUndo(): boolean {
    return historyCanUndo(this.history);
  }

  canRedo(): boolean {
    return historyCanRedo(this.history);
  }

  /**
   * Replace the document with a supplied record list. Used to replay a persisted document
   * and by the replay benchmark; the canvas is derived from these records exactly as it is
   * from drawn ones.
   */
  loadRecords(records: readonly PaintRecord[]): void {
    this.history = createHistory();
    for (const record of records) this.history = push(this.history, record);
    this.repaintBase();
    this.clearOverlay();
    this.requestRender();
    this.emit();
  }

  private clearOverlay(): void {
    const ctx = this.overlayCtx;
    const overlay = this.overlay;
    if (!ctx || !overlay) return;
    ctx.save();
    try {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, overlay.width, overlay.height);
    } finally {
      ctx.restore();
    }
  }

  // ─── gesture lifecycle ────────────────────────────────────────────────────────

  private toRaster(event: { clientX: number; clientY: number }): Pt | null {
    const stage = this.stage;
    if (!stage) return null;
    return screenToRaster(
      { x: event.clientX, y: event.clientY },
      stage.rect,
      stage.size,
      this.doc,
      this.viewport,
    );
  }

  private beginGesture(event: PointerEvent): void {
    const point = this.toRaster(event);
    if (!point) return;

    if (isShapeTool(this.tool)) {
      this.anchor = point;
      this.current = this.buildShape(point, point);
    } else {
      // The eraser is ALWAYS destination-out. Because the background is composited beneath
      // the artwork rather than baked into it, an erased region simply holds no artwork —
      // so whether it reads as the background colour or as transparency falls out of the
      // background setting, and a later background change repaints it automatically.
      // Baking the background in and painting it here was what froze erased pixels.
      const erasing = this.tool === "eraser";
      this.current = {
        kind: "stroke",
        tool: this.tool,
        composite: erasing ? "destination-out" : "source-over",
        color: erasing ? "" : this.foreground,
        width: this.width,
        points: [point],
      };
    }

    this.paintOverlay();
    this.requestRender();
  }

  private buildShape(from: Pt, to: Pt): ShapeRecord {
    const geometry = normalizeShape(this.tool as ShapeKind, from, to, this.constrain);
    return {
      kind: "shape",
      shape: geometry.kind,
      from: geometry.from,
      to: geometry.to,
      strokeColor: this.foreground,
      fillColor: this.fillShapes ? this.foreground : null,
      strokeWidth: this.width,
    };
  }

  private extendGesture(event: PointerEvent): void {
    const active = this.current;
    if (!active) return;

    if (isShapeTool(this.tool) && this.anchor) {
      const point = this.toRaster(event);
      if (point) this.current = this.buildShape(this.anchor, point);
    } else if (active.kind === "stroke") {
      const points = active.points as Pt[];
      // Coalesced events carry the full input sample rate. The `pointerdown` coordinate is
      // NOT among them, which is why `beginGesture` seeds the list first.
      const samples =
        typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [];
      if (samples.length > 0) {
        for (const sample of samples) {
          const point = this.toRaster(sample);
          if (point) points.push(point);
        }
      } else {
        const point = this.toRaster(event);
        if (point) points.push(point);
      }
    }

    this.paintOverlay();
    this.requestRender();
  }

  private endGesture(): void {
    const record = this.current;
    this.current = null;
    this.anchor = null;
    this.activePointerId = null;

    if (!record) {
      this.clearOverlay();
    } else if (
      record.kind === "shape" &&
      isDegenerate({ kind: record.shape, from: record.from, to: record.to })
    ) {
      // A zero-extent shape renders as nothing, so it is never worth entering history.
      this.clearOverlay();
    } else {
      this.commit(record);
    }
    this.requestRender();
  }

  private cancelGesture(): void {
    this.current = null;
    this.anchor = null;
    this.activePointerId = null;
    this.clearOverlay();
    this.requestRender();
  }

  private handlePointerDown = (event: PointerEvent): void => {
    if (event.button === 1 || (this.spaceHeld && event.button === 0)) {
      this.panPointerId = event.pointerId;
      this.lastPan = { x: event.clientX, y: event.clientY };
      this.view?.setPointerCapture(event.pointerId);
      event.preventDefault();
      return;
    }

    if (event.button !== 0) return;

    // Single-active-pointer invariant: a second concurrent pointer must not overwrite the
    // in-progress stroke's points or be adopted by the first stroke's pointerup.
    if (this.activePointerId !== null) return;

    this.activePointerId = event.pointerId;
    this.view?.setPointerCapture(event.pointerId);
    this.beginGesture(event);
    event.preventDefault();
  };

  private handlePointerMove = (event: PointerEvent): void => {
    if (event.pointerId === this.panPointerId && this.lastPan) {
      this.panBy(event.clientX - this.lastPan.x, event.clientY - this.lastPan.y);
      this.lastPan = { x: event.clientX, y: event.clientY };
      return;
    }

    if (event.pointerId !== this.activePointerId) return;

    // Hover filter. Pointer moves fire with buttons === 0; without this a pen or mouse
    // merely passing over the canvas would draw.
    if (event.buttons === 0) {
      this.cancelGesture();
      return;
    }

    this.extendGesture(event);
    event.preventDefault();
  };

  private handlePointerUp = (event: PointerEvent): void => {
    if (event.pointerId === this.panPointerId) {
      this.panPointerId = null;
      this.lastPan = null;
      return;
    }
    if (event.pointerId !== this.activePointerId) return;
    this.endGesture();
  };

  private handleStageHover = (event: PointerEvent): void => {
    // If a gesture is somehow left active with no buttons pressed (lost focus, synthetic
    // event), release it rather than letting the canvas latch in a drawing state.
    if (event.pointerId === this.activePointerId && event.buttons === 0) {
      this.cancelGesture();
    }
  };

  private handleWheel = (event: WheelEvent): void => {
    const stage = this.stage;
    if (!stage) return;
    event.preventDefault();

    this.userAdjustedZoom = true;
    const factor = Math.exp(-event.deltaY * 0.0015);
    const nextZoom = clampZoom(this.viewport.zoom * factor);

    // Anchor on the cursor so the document point under it stays put.
    this.viewport = zoomAtCursor(
      stage.rect,
      stage.size,
      this.doc,
      this.viewport,
      { x: event.clientX, y: event.clientY },
      nextZoom,
    );
    this.relayout();
    this.emit();
  };

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (event.code === "Space" && !this.spaceHeld) {
      this.spaceHeld = true;
      this.applyCursor();
      event.preventDefault();
      return;
    }
    // Only text-entry contexts should swallow shortcuts. A focused range slider must not
    // disable undo or the tool keys — otherwise touching the size control silently kills
    // the whole keyboard layer.
    if (isTextEntryTarget(event.target)) return;

    const accel = event.ctrlKey || event.metaKey;
    if (accel && !event.altKey) {
      const key = event.key.toLowerCase();
      // Cmd/Ctrl+Z is undo; redo is either Shift+Z or the legacy Y.
      if (key === "z" && !event.shiftKey) {
        this.undo();
        event.preventDefault();
        return;
      }
      if ((key === "z" && event.shiftKey) || key === "y") {
        this.redo();
        event.preventDefault();
        return;
      }
      return;
    }

    if (event.key === "1") this.setTool("pencil");
    if (event.key === "2") this.setTool("eraser");
    if (event.key === "3") this.setTool("line");
    if (event.key === "4") this.setTool("rect");
    if (event.key === "5") this.setTool("ellipse");
    if (event.key === "[") this.setWidth(this.width - 1);
    if (event.key === "]") this.setWidth(this.width + 1);
    if (event.key === "x" || event.key === "X") this.swapColors();
  };

  /** Track Shift so shape drags can constrain to 45°/square/circle. */
  private handleModifierChange = (event: KeyboardEvent): void => {
    if (event.key !== "Shift") return;
    this.constrain = event.shiftKey;
    // A held modifier only matters mid-drag; re-render so the preview tightens immediately.
    if (this.current) {
      this.paintOverlay();
      this.requestRender();
    }
  };

  private handleKeyUp = (event: KeyboardEvent): void => {
    if (event.code === "Space") {
      this.spaceHeld = false;
      this.applyCursor();
    }
  };

  private applyCursor(): void {
    if (!this.view) return;
    if (this.spaceHeld) {
      this.view.style.cursor = "grab";
      return;
    }
    this.view.style.cursor =
      this.tool === "eraser" ? "cell" : FREEHAND_TOOLS.has(this.tool) ? "crosshair" : "copy";
  }

  private preventContextMenu = (event: Event): void => {
    event.preventDefault();
  };

  /**
   * Composite the document — background beneath artwork — into a scratch canvas at the
   * document's own raster size.
   *
   * This is the single source of truth for "what the document looks like". Exports and
   * snapshots both go through here so they cannot drift apart. Crucially this is NOT the
   * view canvas: the view carries the current zoom and devicePixelRatio, so exporting it
   * would silently ship a low-resolution file.
   */
  renderDocument(): HTMLCanvasElement | null {
    const base = this.base;
    if (!base) return null;

    const scratch = document.createElement("canvas");
    scratch.width = base.width;
    scratch.height = base.height;
    const ctx = scratch.getContext("2d");
    if (!ctx) return null;

    if (this.background !== null) {
      ctx.fillStyle = this.background;
      ctx.fillRect(0, 0, scratch.width, scratch.height);
    }
    ctx.drawImage(base, 0, 0);
    return scratch;
  }

  /** Debug/e2e affordance: the committed document as a PNG data URL. */
  snapshotDataUrl(): string | null {
    return this.renderDocument()?.toDataURL("image/png") ?? null;
  }

  /**
   * The document as a PNG blob.
   *
   * A blob rather than a data URL: `toDataURL` base64-encodes roughly 15 MB of pixels into
   * a single string on the main thread, which is a visible stall on a large document.
   */
  exportBlob(): Promise<Blob | null> {
    const scratch = this.renderDocument();
    if (!scratch) return Promise.resolve(null);
    return new Promise((resolve) => {
      scratch.toBlob((blob) => resolve(blob), "image/png");
    });
  }

  /** Suggested filename for an export: `paintpad-<YYYYMMDD-HHMMSS>.png`. */
  exportFilename(): string {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp =
      `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
      `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    return `paintpad-${stamp}.png`;
  }

  /** Debug/e2e affordance: committed record count. */
  get recordCount(): number {
    return this.history.entries.length;
  }

  /**
   * Debug/e2e affordance: a structured copy of history. Tests assert on record geometry
   * directly rather than inferring it from rendered pixels.
   */
  historyEntries(): PaintRecord[] {
    return structuredClone(this.history.entries) as PaintRecord[];
  }

  /**
   * Debug/e2e affordance: count of non-background pixels in the committed document.
   * Used to prove a render actually put ink down, so a comparison test cannot pass
   * vacuously against a blank canvas.
   */
  documentInkCount(): number {
    const ctx = this.baseCtx;
    const base = this.base;
    if (!ctx || !base) return 0;

    // `base` holds artwork only — the background is not in it — so "ink" is simply "not
    // transparent". One rule covers both background modes.
    const { data } = ctx.getImageData(0, 0, base.width, base.height);
    let ink = 0;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i]! > 0) ink++;
    }
    return ink;
  }
}
import { expect, type Locator, type Page } from "@playwright/test";
import type { PaintRecord } from "../src/canvas/record";
import type { ToolId } from "../src/canvas/record";
import type { ExportTierId } from "../src/canvas/exportScale";

const CANVAS = "canvas.surface";

declare global {
  interface Window {
    __paintpad: {
      recordCount: number;
      snapshotDataUrl(): string | null;
      documentInkCount(): number;
      documentState(): unknown;
      getSelection(): unknown;
      settings(): {
        tool: ToolId;
        foreground: string;
        background: string | null;
        viewport: { zoom: number; panX: number; panY: number };
        canUndo: boolean;
        canRedo: boolean;
        recordCount: number;
        hasSelection: boolean;
        selectionSize: { width: number; height: number } | null;
      };
      undo(): void;
      redo(): void;
      canUndo(): boolean;
      canRedo(): boolean;
      historyEntries(): PaintRecord[];
      loadRecords(records: PaintRecord[]): void;
      reset(): void;
      fitToStage(): void;
      exportBlob(tier?: ExportTierId): Promise<Blob | null>;
    };
    /** DEV-only hook, so the suite can install a sink the way a real provider would be. */
    __setAnalyticsSink(sink: ((event: unknown) => void) | null): void;
  }
}

/**
 * Draw a path on the canvas with synthetic pointer events.
 *
 * `steps` controls how many `pointermove` samples are emitted, which is how we reproduce
 * the specific input conditions that trigger the historical bugs:
 *   steps: 2  -> a fast flick (the "missing tail" canary)
 *   steps: 1  -> a tap        (the "missing dot" canary)
 *   many     -> a diagonal    (the "joint beading" canary)
 */
export async function drawStroke(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  options: { steps?: number; button?: "left" } = {},
): Promise<void> {
  const steps = options.steps ?? 24;
  const button = options.button ?? "left";
  const canvas = page.locator(CANVAS);
  const box = (await canvas.boundingBox())!;

  // Guard: the stage clips with `overflow: hidden`, so `boundingBox()` can report a region
  // that is not actually on the canvas. Drawing there hits the page behind it and silently
  // produces a blank result — which is exactly the bug this helper once hid.
  const onCanvas = await page.evaluate(
    ({ x, y }) => document.elementFromPoint(x, y)?.classList.contains("surface") ?? false,
    { x: box.x + from.x, y: box.y + from.y },
  );
  expect(
    onCanvas,
    `draw start point (${from.x},${from.y}) is not over the canvas — the canvas is probably clipped by the stage`,
  ).toBe(true);

  await page.mouse.move(box.x + from.x, box.y + from.y);
  await page.mouse.down({ button });
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await page.mouse.move(box.x + from.x + (to.x - from.x) * t, box.y + from.y + (to.y - from.y) * t);
  }
  await page.mouse.up({ button });
  await page.waitForTimeout(60);
}

export async function setWidth(page: Page, width: number): Promise<void> {
  await page.locator('input[type="range"]').fill(String(width));
}

export async function setTool(page: Page, tool: ToolId): Promise<void> {
  await page.locator(`button[data-tool="${tool}"]`).click();
}

/** Toggle shape fill on or off. */
export async function setFill(page: Page, fill: boolean): Promise<void> {
  const toggle = page.locator('button[data-fill="toggle"]');
  if ((await toggle.getAttribute("aria-pressed")) === String(fill)) return;
  await toggle.click();
}

/** Draw a shape by dragging, optionally holding Shift for the constraint. */
export async function dragShape(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  options: { shift?: boolean } = {},
): Promise<void> {
  const canvas = page.locator(CANVAS);
  const box = (await canvas.boundingBox())!;

  if (options.shift) await page.keyboard.down("Shift");
  await page.mouse.move(box.x + from.x, box.y + from.y);
  await page.mouse.down();
  // A handful of intermediate moves, so this exercises the same live-preview path a real
  // drag does rather than jumping straight to the endpoint.
  for (let i = 1; i <= 6; i++) {
    const t = i / 6;
    await page.mouse.move(box.x + from.x + (to.x - from.x) * t, box.y + from.y + (to.y - from.y) * t);
  }
  await page.mouse.up();
  if (options.shift) await page.keyboard.up("Shift");
  await page.waitForTimeout(60);
}

/** Zoom via the toolbar multiplier, which routes through the same code as the wheel. */
export async function setZoom(page: Page, zoom: number): Promise<void> {
  await page.getByRole("button", { name: "1:1" }).click();
  const steps = Math.round(Math.log2(zoom) * 2);
  const direction = steps >= 0 ? "+" : "−";
  const count = Math.abs(steps);
  for (let i = 0; i < count; i++) {
    await page.getByRole("button", { name: direction, exact: true }).click();
  }
}

export async function clearCanvas(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Clear" }).click();
  await page.waitForTimeout(60);
}

/** The canvas element. */
export function canvasLocator(page: Page): Locator {
  return page.locator(CANVAS);
}

/**
 * Capture the COMPOSITED view pixels as a PNG buffer.
 *
 * We deliberately golden the canvas bitmap rather than an element screenshot. The canvas is
 * 720px tall inside a shorter stage, so `overflow: hidden` clips it and an element
 * screenshot captures whatever page chrome overlaps the bounding box instead.
 *
 * Prefer `documentPixels` for anything about how strokes render. This reads the *view*, which
 * is composited at the current zoom, so at fit-to-stage its size tracks the stage
 * measurement — widening the toolbar resizes the bitmap and fails the snapshot without the
 * renderer having changed. It is the right tool only for defects that live in the
 * compositing or the alpha channel, where the document raster shows nothing.
 */
export async function canvasPixels(page: Page): Promise<Buffer> {
  const dataUrl = await page.evaluate(() => {
    const canvas = document.querySelector("canvas.surface") as HTMLCanvasElement;
    return canvas.toDataURL("image/png");
  });
  return Buffer.from(dataUrl.split(",")[1]!, "base64");
}

/**
 * Committed document pixels — the artwork-only base raster.
 *
 * Fixed size, independent of zoom, `devicePixelRatio`, and page layout, so this is the
 * stable target for renderer goldens. Note that Playwright treats fully transparent pixels
 * as "don't care", so this cannot verify alpha; assert alpha directly instead.
 */
export async function documentPixels(page: Page): Promise<Buffer> {
  const dataUrl = await page.evaluate(() => window.__paintpad.snapshotDataUrl());
  return Buffer.from((dataUrl ?? "").split(",")[1] ?? "", "base64");
}

/** Assert that the app booted and the engine attached without console errors. */
export async function expectNoConsoleErrors(page: Page): Promise<void> {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await expect(errors).toEqual([]);
}
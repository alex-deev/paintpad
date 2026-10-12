import { expect, test } from "@playwright/test";
import {
  canvasLocator,
  canvasPixels,
  clearCanvas,
  documentPixels,
  drawStroke,
  setTool,
  setWidth,
} from "./helpers";

/**
 * Golden snapshot tests. Each is the canary for a specific fatal defect found in the
 * render-engine design review. See SPEC-render-engine.md → Locked Decisions.
 *
 * These snapshot raster pixels, not a page screenshot — see `canvasPixels`.
 *
 * Every test here pins zoom to 1:1 and snapshots the **document raster**. The default is
 * fit-to-stage, which scales the raster to whatever the stage happens to measure — so adding
 * one button to the toolbar used to resize all eight goldens and fail them, with nothing
 * about the renderer having changed. At a fixed zoom on a fixed-size raster, these are
 * independent of page chrome entirely.
 *
 * 1:1 needs a viewport that can actually show the whole 1280x720 raster. At the default
 * 1280x720 the canvas is centred inside a smaller stage, so it overflows, its top-left lands
 * off-screen, and small draw coordinates fall through to the toolbar. The viewport is the
 * one piece of layout these tests still depend on, which is a deliberate trade: it is
 * configuration that changes rarely, whereas the toolbar changes constantly.
 */
test.use({ viewport: { width: 1600, height: 1000 } });

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(canvasLocator(page)).toBeVisible();
  await clearCanvas(page);
  await page.getByRole("button", { name: "1:1" }).click();
});

test("1px diagonal has no joint beading", async ({ page }) => {
  // One `stroke()` per segment double-composites the antialiased round caps at every joint,
  // producing one visible bead per input event. Opaque colours are affected too — the cause
  // is coverage overlap, not colour alpha.
  await setWidth(page, 1);
  await drawStroke(page, { x: 20, y: 20 }, { x: 380, y: 300 }, { steps: 40 });
  expect(await documentPixels(page)).toMatchSnapshot("beading-1px-diagonal.png");
});

test("width sweep renders consistently", async ({ page }) => {
  for (const width of [1, 2, 8, 64]) {
    await clearCanvas(page);
    await setWidth(page, width);
    await drawStroke(page, { x: 20, y: 40 }, { x: 380, y: 240 }, { steps: 30 });
    expect(await documentPixels(page)).toMatchSnapshot(`width-${width}.png`);
  }
});

test("a fast flick renders a complete stroke", async ({ page }) => {
  // Two input samples. Midpoint smoothing with no explicit tail flush drops the final
  // half-segment, so naive implementations truncate fast strokes.
  await setWidth(page, 4);
  await drawStroke(page, { x: 30, y: 30 }, { x: 420, y: 300 }, { steps: 2 });
  expect(await documentPixels(page)).toMatchSnapshot("flick-2-samples.png");
});

test("a single tap renders a visible dot", async ({ page }) => {
  // A zero-length subpath with a round cap renders inconsistently across browsers; the
  // engine must emit an explicit arc for degenerate strokes.
  await setWidth(page, 8);
  await drawStroke(page, { x: 200, y: 180 }, { x: 200, y: 180 }, { steps: 1 });
  expect(await documentPixels(page)).toMatchSnapshot("tap-dot.png");
});

test("zoom leaves no ghost pixels", async ({ page }) => {
  // `clearRect` is subject to the current transform. With a leftover scale it clears only a
  // fraction of the surface, stranding stale pixels from the previous zoom level.
  await setWidth(page, 12);
  await drawStroke(page, { x: 40, y: 40 }, { x: 360, y: 260 }, { steps: 30 });
  const beforeZoom = await documentPixels(page);

  const zoomIn = page.getByRole("button", { name: "+", exact: true });
  const zoomOut = page.getByRole("button", { name: "−", exact: true });

  for (let i = 0; i < 4; i++) await zoomIn.click();
  await page.waitForTimeout(80);
  expect(await documentPixels(page)).toMatchSnapshot("zoom-in-4x.png");

  for (let i = 0; i < 4; i++) await zoomOut.click();
  await page.waitForTimeout(80);
  expect(await documentPixels(page)).toMatchSnapshot("zoom-back-to-1x.png");

  // Zooming is a view concern: the artwork underneath must come back byte-identical.
  expect(await documentPixels(page)).toEqual(beforeZoom);
});

test("the eraser punches through, revealing the background", async ({ page }) => {
  // The eraser is unconditionally `destination-out`. Since the background is composited
  // beneath the artwork rather than baked into it, the erased run is a gap in the artwork
  // that the background shows through.
  //
  // This one golden the COMPOSITED view rather than the document raster: the defect is a
  // hole, and Playwright treats fully transparent pixels as "don't care", so a document-raster
  // snapshot would pass whether the hole was there or not. The alpha itself is asserted
  // directly in transparency.spec.ts.
  await setWidth(page, 16);
  await drawStroke(page, { x: 40, y: 160 }, { x: 360, y: 160 }, { steps: 20 });

  await setTool(page, "eraser");
  await drawStroke(page, { x: 120, y: 100 }, { x: 240, y: 220 }, { steps: 20 });
  expect(await canvasPixels(page)).toMatchSnapshot("eraser-destination-out.png");
});

test("hovering the canvas draws nothing", async ({ page }) => {
  // Pointer moves fire with buttons === 0. Without a filter, passing the mouse over the
  // canvas would paint.
  const box = (await canvasLocator(page).boundingBox())!;
  for (let i = 0; i < 12; i++) {
    await page.mouse.move(box.x + 40 + i * 25, box.y + 60 + (i % 3) * 40);
    await page.mouse.move(box.x + 45 + i * 25, box.y + 80 + (i % 3) * 40);
  }
  await page.waitForTimeout(80);
  // A blank raster would also satisfy the snapshot, so assert the count directly.
  expect(await page.evaluate(() => window.__paintpad.documentInkCount())).toBe(0);
  expect(await documentPixels(page)).toMatchSnapshot("hover-draws-nothing.png");
});

test("a second concurrent pointer cannot corrupt a stroke", async ({ page }) => {
  // The single-active-pointer invariant: a second `pointerdown` must not overwrite the
  // in-progress stroke's points or be adopted by the first stroke's `pointerup`.
  await setWidth(page, 10);
  const box = (await canvasLocator(page).boundingBox())!;

  await page.mouse.move(box.x + 40, box.y + 300);
  await page.mouse.down();
  await page.mouse.move(box.x + 140, box.y + 260);
  // Simulate a stray second contact while the first is still down.
  await page.mouse.move(box.x + 400, box.y + 40, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(80);

  expect(await documentPixels(page)).toMatchSnapshot("concurrent-pointer.png");
});
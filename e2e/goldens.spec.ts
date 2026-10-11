import { expect, test } from "@playwright/test";
import { canvasLocator, canvasPixels, clearCanvas, drawStroke, setTool, setWidth } from "./helpers";

/**
 * Golden snapshot tests. Each is the canary for a specific fatal defect found in the
 * render-engine design review. See SPEC-render-engine.md → Locked Decisions.
 *
 * These snapshot the canvas bitmap, not a page screenshot — see `canvasPixels`.
 */

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(canvasLocator(page)).toBeVisible();
  await clearCanvas(page);
});

test("1px diagonal has no joint beading", async ({ page }) => {
  // One `stroke()` per segment double-composites the antialiased round caps at every joint,
  // producing one visible bead per input event. Opaque colours are affected too — the cause
  // is coverage overlap, not colour alpha.
  await setWidth(page, 1);
  await drawStroke(page, { x: 20, y: 20 }, { x: 380, y: 300 }, { steps: 40 });
  expect(await canvasPixels(page)).toMatchSnapshot("beading-1px-diagonal.png");
});

test("width sweep renders consistently", async ({ page }) => {
  for (const width of [1, 2, 8, 64]) {
    await clearCanvas(page);
    await setWidth(page, width);
    await drawStroke(page, { x: 20, y: 40 }, { x: 380, y: 240 }, { steps: 30 });
    expect(await canvasPixels(page)).toMatchSnapshot(`width-${width}.png`);
  }
});

test("a fast flick renders a complete stroke", async ({ page }) => {
  // Two input samples. Midpoint smoothing with no explicit tail flush drops the final
  // half-segment, so naive implementations truncate fast strokes.
  await setWidth(page, 4);
  await drawStroke(page, { x: 30, y: 30 }, { x: 420, y: 300 }, { steps: 2 });
  expect(await canvasPixels(page)).toMatchSnapshot("flick-2-samples.png");
});

test("a single tap renders a visible dot", async ({ page }) => {
  // A zero-length subpath with a round cap renders inconsistently across browsers; the
  // engine must emit an explicit arc for degenerate strokes.
  await setWidth(page, 8);
  await drawStroke(page, { x: 200, y: 180 }, { x: 200, y: 180 }, { steps: 1 });
  expect(await canvasPixels(page)).toMatchSnapshot("tap-dot.png");
});

test("zoom leaves no ghost pixels", async ({ page }) => {
  // `clearRect` is subject to the current transform. With a leftover scale it clears only a
  // fraction of the surface, stranding stale pixels from the previous zoom level.
  await setWidth(page, 12);
  await drawStroke(page, { x: 40, y: 40 }, { x: 360, y: 260 }, { steps: 30 });

  const zoomIn = page.getByRole("button", { name: "+", exact: true });
  const zoomOut = page.getByRole("button", { name: "−", exact: true });

  for (let i = 0; i < 4; i++) await zoomIn.click();
  await page.waitForTimeout(80);
  expect(await canvasPixels(page)).toMatchSnapshot("zoom-in-4x.png");

  for (let i = 0; i < 4; i++) await zoomOut.click();
  await page.waitForTimeout(80);
  expect(await canvasPixels(page)).toMatchSnapshot("zoom-back-to-1x.png");
});

test("the eraser paints the background rather than punching a hole", async ({ page }) => {
  // The eraser deliberately uses source-over with the background colour. A destination-out
  // pass against the transparent overlay would erase nothing at all.
  await setWidth(page, 16);
  await drawStroke(page, { x: 40, y: 160 }, { x: 360, y: 160 }, { steps: 20 });

  await setTool(page, "eraser");
  await drawStroke(page, { x: 120, y: 100 }, { x: 240, y: 220 }, { steps: 20 });
  expect(await canvasPixels(page)).toMatchSnapshot("eraser-source-over.png");
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
  expect(await canvasPixels(page)).toMatchSnapshot("hover-draws-nothing.png");
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

  expect(await canvasPixels(page)).toMatchSnapshot("concurrent-pointer.png");
});
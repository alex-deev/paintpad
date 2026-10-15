import { expect, test } from "@playwright/test";
import { canvasLocator, clearCanvas, drawStroke, setTool, setWidth } from "./helpers";
import type { ExportTierId } from "../src/canvas/exportScale";

/**
 * Export size tiers.
 *
 * The tier arithmetic is unit-tested in tests/unit/exportScale.test.ts. What cannot be
 * measured there is whether the canvas actually produces those dimensions, and whether
 * downscaling preserves alpha and background compositing -- so that is asserted here,
 * against a real decode of the produced blob.
 */

/** Export at a tier, decode the result, and report its true pixel size and alpha. */
async function measure(page: import("@playwright/test").Page, tier: ExportTierId) {
  return page.evaluate(async (t) => {
    const blob = await window.__paintpad.exportBlob(t);
    if (!blob) return null;
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(bitmap, 0, 0);
    const { data: px } = ctx.getImageData(0, 0, canvas.width, canvas.height);

    let opaque = 0;
    let transparent = 0;
    for (let i = 3; i < px.length; i += 4) {
      if (px[i] === 0) transparent++;
      else if (px[i] === 255) opaque++;
    }
    return {
      width: bitmap.width,
      height: bitmap.height,
      opaque,
      transparent,
      total: px.length / 4,
    };
  }, tier);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(canvasLocator(page)).toBeVisible();
  await page.evaluate(() => localStorage.clear());
  await clearCanvas(page);
});

test("the full tier exports the document's raster size", async ({ page }) => {
  // The default document is 1280x720 logical at rasterScale 2.
  expect(await measure(page, "full")).toMatchObject({ width: 2560, height: 1440 });
});

test("the standard tier exports the document's logical size", async ({ page }) => {
  expect(await measure(page, "standard")).toMatchObject({ width: 1280, height: 720 });
});

test("the small tier exports half the logical size", async ({ page }) => {
  expect(await measure(page, "small")).toMatchObject({ width: 640, height: 360 });
});

test("omitting the tier matches the full tier", async ({ page }) => {
  // The no-argument call predates tiers; it must not have silently changed meaning.
  const implicit = await page.evaluate(async () => {
    const blob = await window.__paintpad.exportBlob();
    if (!blob) return null;
    const bitmap = await createImageBitmap(blob);
    return { width: bitmap.width, height: bitmap.height };
  });
  expect(implicit).toEqual({ width: 2560, height: 1440 });
});

test("a downscaled tier preserves real transparency", async ({ page }) => {
  const info = await measure(page, "small");
  expect(info).not.toBeNull();
  // An empty document stays empty: no white fill introduced by the downscale.
  expect(info!.transparent).toBe(info!.total);
  expect(info!.opaque).toBe(0);
});

test("a downscaled tier still composites a solid background", async ({ page }) => {
  await page.getByTestId("swatch-background").click();
  await page.getByTestId("hex-input").fill("#1b9e77");
  await page.getByTestId("hex-input").press("Enter");
  await page.waitForTimeout(150);

  const info = await measure(page, "small");
  expect(info).not.toBeNull();
  expect(info!.transparent).toBe(0);
  expect(info!.opaque).toBe(info!.total);
});

test("a downscaled tier still contains the artwork", async ({ page }) => {
  await setWidth(page, 30);
  await drawStroke(page, { x: 200, y: 300 }, { x: 700, y: 400 }, { steps: 22 });

  const info = await measure(page, "small");
  expect(info).not.toBeNull();
  expect(info!.opaque).toBeGreaterThan(1_000);
  // The stroke must not have been scaled up to fill the canvas.
  expect(info!.transparent).toBeGreaterThan(info!.total / 2);
});

test("a downscaled tier keeps erased regions transparent", async ({ page }) => {
  // Guards the composited-background model through the new downscale path: erasing must
  // punch through the background, not paint the previous one back in.
  await setWidth(page, 30);
  await drawStroke(page, { x: 60, y: 200 }, { x: 500, y: 200 }, { steps: 22 });

  await page.getByTestId("swatch-background").click();
  await page.getByTestId("hex-input").fill("#4361ee");
  await page.getByTestId("hex-input").press("Enter");
  await page.waitForTimeout(150);

  await setTool(page, "eraser");
  await drawStroke(page, { x: 230, y: 80 }, { x: 230, y: 340 }, { steps: 18 });

  await page.getByTestId("background-none").click();
  await page.waitForTimeout(150);

  const info = await measure(page, "small");
  expect(info).not.toBeNull();
  expect(info!.transparent).toBeGreaterThan(0);
  expect(info!.opaque).toBeGreaterThan(500);
});

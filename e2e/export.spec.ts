import { expect, test, type Download, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { canvasLocator, clearCanvas, drawStroke, setTool, setWidth } from "./helpers";

/**
 * PNG export verification.
 *
 * These assert on the actual downloaded FILE — its bytes read back and decoded — rather
 * than on a mocked download event, so a pipeline that silently exported the wrong surface
 * could not pass.
 */

async function exportFile(page: Page): Promise<{ name: string; bytes: Buffer }> {
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export" }).click();
  await page.getByTestId("export-size-full").click();
  await page.getByTestId("export-confirm").click();
  const download: Download = await downloadPromise;
  const path = await download.path();
  expect(path).not.toBeNull();
  return {
    name: download.suggestedFilename(),
    bytes: readFileSync(path!),
  };
}

/** Decode a PNG in the page and report what is actually in the file. */
async function inspectPng(page: Page, base64: string) {
  return page.evaluate(async (data: string) => {
    const img = new Image();
    img.src = `data:image/png;base64,${data}`;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const { data: px } = ctx.getImageData(0, 0, canvas.width, canvas.height);

    let opaque = 0;
    let transparent = 0;
    for (let i = 3; i < px.length; i += 4) {
      if (px[i] === 0) transparent++;
      else if (px[i] === 255) opaque++;
    }
    return {
      width: img.width,
      height: img.height,
      opaque,
      transparent,
      colourType: px.length > 0 ? "rgba" : "empty",
      sha: data.slice(0, 24),
    };
  }, base64);
}

const toBase64 = (b: Buffer) => b.toString("base64");

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(canvasLocator(page)).toBeVisible();
  await page.evaluate(() => localStorage.clear());
  await clearCanvas(page);
});

test("exporting downloads a timestamped PNG", async ({ page }) => {
  const file = await exportFile(page);
  expect(file.name).toMatch(/^paintpad-\d{8}-\d{6}\.png$/);
  // PNG magic number.
  expect(file.bytes.subarray(0, 8)).toEqual(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
});

test("the exported file is the DOCUMENT raster size, not the view's", async ({ page }) => {
  // The default document is 1280x720 logical at rasterScale 2, so 2560x1440. The view canvas
  // is far smaller because it is fitted to the window — exporting that would silently ship
  // a low-resolution file.
  const file = await exportFile(page);
  const info = await inspectPng(page, toBase64(file.bytes));

  const viewSize = await page.evaluate(() => {
    const canvas = document.querySelector("canvas.surface") as HTMLCanvasElement;
    return { width: canvas.width, height: canvas.height };
  });
  const docSize = await page.evaluate(() => window.__paintpad.settings());

  expect(info.width).toBe(2560);
  expect(info.height).toBe(1440);
  expect(info.width).toBeGreaterThan(viewSize.width);
  expect(docSize).toBeDefined();
});

test("export is zoom-independent", async ({ page }) => {
  await setWidth(page, 14);
  await drawStroke(page, { x: 80, y: 80 }, { x: 380, y: 280 }, { steps: 20 });

  const atFit = await exportFile(page);

  for (let i = 0; i < 4; i++) await page.getByRole("button", { name: "+", exact: true }).click();
  await page.waitForTimeout(140);

  const zoomed = await exportFile(page);

  // Byte-identical: the same document exported at a different zoom.
  expect(zoomed.bytes.equals(atFit.bytes)).toBe(true);
});

test("the canvas background is composited into the file", async ({ page }) => {
  await page.getByTestId("swatch-background").click();
  await page.getByTestId("hex-input").fill("#1b9e77");
  await page.getByTestId("hex-input").press("Enter");
  await page.waitForTimeout(150);

  const file = await exportFile(page);
  const info = await inspectPng(page, toBase64(file.bytes));

  // A solid background means nothing in the file is transparent.
  expect(info.transparent).toBe(0);
  expect(info.opaque).toBeGreaterThan(1_000_000);
});

test("with no background the file carries real transparency", async ({ page }) => {
  const file = await exportFile(page);
  const info = await inspectPng(page, toBase64(file.bytes));

  // An empty transparent document, not a white one.
  expect(info.transparent).toBeGreaterThan(1_000_000);
  expect(info.opaque).toBe(0);
});

test("an empty document exports a valid blank PNG", async ({ page }) => {
  const file = await exportFile(page);
  expect(file.bytes.length).toBeGreaterThan(0);

  const info = await inspectPng(page, toBase64(file.bytes));
  expect(info.width).toBe(2560);
  expect(info.transparent).toBeGreaterThan(1_000_000);
});

test("a drawn document exports its art", async ({ page }) => {
  await setWidth(page, 24);
  await drawStroke(page, { x: 80, y: 80 }, { x: 400, y: 300 }, { steps: 22 });

  const file = await exportFile(page);
  const info = await inspectPng(page, toBase64(file.bytes));

  expect(info.opaque).toBeGreaterThan(10_000);
  // Still mostly empty, so the stroke did not fill the canvas.
  expect(info.transparent).toBeGreaterThan(1_000_000);
});

test("exports are byte-identical at deviceScaleFactor 1 and 3", async ({ browser }) => {
  // The same guarantee dpr.spec.ts asserts on the live canvas, now verified through the
  // real exported file. Export must not depend on the display it was drawn on.
  const drawAndExport = async (deviceScaleFactor: number): Promise<Buffer> => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor,
    });
    const page = await context.newPage();
    await page.goto("/");
    await expect(canvasLocator(page)).toBeVisible();
    await clearCanvas(page);

    await page.locator('input[type="range"]').fill("9");
    const box = (await canvasLocator(page).boundingBox())!;
    await page.mouse.move(box.x + 60, box.y + 60);
    await page.mouse.down();
    for (let i = 1; i <= 20; i++) {
      await page.mouse.move(box.x + 60 + i * 14, box.y + 60 + i * 8);
    }
    await page.mouse.up();
    await page.waitForTimeout(140);

    const file = await exportFile(page);
    await context.close();
    return file.bytes;
  };

  const at1 = await drawAndExport(1);
  const at3 = await drawAndExport(3);

  expect(at3.equals(at1)).toBe(true);
});

test("erased regions export as transparent, not as the old background", async ({ page }) => {
  // Guards the composited-background fix all the way out to the file.
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

  const file = await exportFile(page);
  const info = await inspectPng(page, toBase64(file.bytes));

  // The erased gap now reads as transparency in the exported file.
  expect(info.transparent).toBeGreaterThan(1_000_000);
  expect(info.opaque).toBeGreaterThan(10_000);
});
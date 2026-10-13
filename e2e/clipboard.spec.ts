import { expect, test, type Page } from "@playwright/test";
import { canvasLocator, clearCanvas, documentPixels, drawStroke, setTool, setWidth } from "./helpers";

/**
 * Copy, cut and paste.
 *
 * A paste is a move with a different offset — the same record shape and the same JSON-safe
 * data URL. That is the payoff of slice 11b: copy and paste needed no new record kind and no
 * encoding decision, which is the problem that has deferred image import twice.
 */

const recordCount = (page: Page) => page.evaluate(() => window.__paintpad.settings().recordCount);
const hasSelection = (page: Page) => page.evaluate(() => window.__paintpad.settings().hasSelection);
const ink = (page: Page) => page.evaluate(() => window.__paintpad.documentInkCount());

async function drag(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  const box = (await canvasLocator(page).boundingBox())!;
  await page.mouse.move(box.x + from.x, box.y + from.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    const t = i / 8;
    await page.mouse.move(box.x + from.x + (to.x - from.x) * t, box.y + from.y + (to.y - from.y) * t);
  }
  await page.mouse.up();
  await page.waitForTimeout(120);
}

/**
 * Sample the ARTWORK raster, not the composited view.
 *
 * These tests assert what was moved, deleted or pasted — document questions. Reading the view
 * instead makes the selection highlight's dim part of the answer: it adds coverage to empty
 * areas, so "this region is now transparent" reads back as dimmed rather than blank.
 */
async function sampleAt(page: Page, x: number, y: number): Promise<number[]> {
  return page.evaluate(
    async ({ x, y }) => {
      const img = new Image();
      img.src = window.__paintpad.snapshotDataUrl()!;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const cx = c.getContext("2d")!;
      cx.drawImage(img, 0, 0);
      const rect = (document.querySelector("canvas.surface") as HTMLCanvasElement)
        .getBoundingClientRect();
      return Array.from(
        cx.getImageData(
          Math.round((x / rect.width) * img.width),
          Math.round((y / rect.height) * img.height),
          1,
          1,
        ).data,
      );
    },
    { x, y },
  );
}


/** A thick band, so a region of it has recognisable pixels. */
async function band(page: Page): Promise<void> {
  await setTool(page, "pencil");
  await setWidth(page, 28);
  await page.getByTestId("swatch-foreground").click();
  await page.locator('button[data-colour="#1b9e77"]').click();
  await drawStroke(page, { x: 250, y: 300 }, { x: 650, y: 300 }, { steps: 24 });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(canvasLocator(page)).toBeVisible();
  await page.evaluate(() => localStorage.clear());
  await clearCanvas(page);
});

test("copy then paste duplicates the region", async ({ page }) => {
  await band(page);
  await setTool(page, "select");
  await drag(page, { x: 250, y: 230 }, { x: 400, y: 370 });

  const before = await ink(page);
  await page.keyboard.press("Control+c");
  await page.keyboard.press("Control+v");
  await page.waitForTimeout(200);

  // Paste does not move the original, so the drawing grows by the copied region.
  expect(await ink(page)).toBeGreaterThan(before);
  expect(await recordCount(page)).toBe(2);
  // The source is untouched.
  expect((await sampleAt(page, 320, 300))[3]).toBe(255);
  // And the paste is selected, ready to be moved.
  expect(await hasSelection(page)).toBe(true);
});

test("cut erases the region and paste puts it back elsewhere", async ({ page }) => {
  await band(page);
  await setTool(page, "select");
  await drag(page, { x: 250, y: 230 }, { x: 400, y: 370 });
  const beforeCut = await ink(page);

  await page.keyboard.press("Control+x");
  await page.waitForTimeout(200);

  // The cut region is gone. A cut is one clearRect record — copying touches no history.
  expect(await recordCount(page)).toBe(2);
  expect(await ink(page)).toBeLessThan(beforeCut);
  expect((await sampleAt(page, 320, 300))[3]).toBe(0);

  await page.keyboard.press("Control+v");
  await page.waitForTimeout(200);
  // Restored elsewhere, not in place — so the cut source stays empty.
  expect((await sampleAt(page, 320, 300))[3]).toBe(0);
});

test("paste is undoable", async ({ page }) => {
  await band(page);
  await setTool(page, "select");
  await drag(page, { x: 250, y: 230 }, { x: 400, y: 370 });
  await page.keyboard.press("Control+c");

  const before = await documentPixels(page);
  await page.keyboard.press("Control+v");
  await page.waitForTimeout(200);
  const pasted = await documentPixels(page);
  expect(pasted).not.toEqual(before);

  await page.evaluate(() => window.__paintpad.undo());
  await page.waitForTimeout(250);
  expect(await documentPixels(page)).toEqual(before);
});

test("copy, cut and paste do nothing without a selection", async ({ page }) => {
  await band(page);
  const before = await documentPixels(page);
  const count = await recordCount(page);

  await page.keyboard.press("Control+c");
  await page.keyboard.press("Control+x");
  await page.waitForTimeout(150);
  expect(await recordCount(page)).toBe(count);
  expect(await documentPixels(page)).toEqual(before);

  // Nothing was ever copied, so paste has nothing to do either.
  await page.keyboard.press("Control+v");
  await page.waitForTimeout(150);
  expect(await recordCount(page)).toBe(count);
  expect(await documentPixels(page)).toEqual(before);
});

test("a paste can be moved straight away, because it is selected", async ({ page }) => {
  await band(page);
  await setTool(page, "select");
  await drag(page, { x: 250, y: 230 }, { x: 400, y: 370 });
  await page.keyboard.press("Control+c");
  await page.keyboard.press("Control+v");
  await page.waitForTimeout(200);

  const afterPaste = await ink(page);
  // Drag from inside the freshly pasted selection: a move, not a new selection.
  await drag(page, { x: 320, y: 300 }, { x: 320, y: 480 });
  expect(await recordCount(page)).toBe(3);
  expect(await ink(page)).toBe(afterPaste);
});

test("pasted content survives a reload", async ({ page }) => {
  await band(page);
  await setTool(page, "select");
  await drag(page, { x: 250, y: 230 }, { x: 400, y: 370 });
  await page.keyboard.press("Control+c");
  await page.keyboard.press("Control+v");
  await page.waitForTimeout(700);

  const before = await documentPixels(page);
  await page.reload();
  await expect(canvasLocator(page)).toBeVisible();
  await page.waitForTimeout(300);
  expect(await documentPixels(page)).toEqual(before);
});

test("pasting repeatedly stays cheap", async ({ page }) => {
  // Regression guard for the exponential history that slice 11b fixed: a clipboard region is
  // stored once per paste as a flat data URL, never nested.
  await band(page);
  await setTool(page, "select");
  await drag(page, { x: 250, y: 230 }, { x: 400, y: 370 });
  await page.keyboard.press("Control+c");

  for (let i = 0; i < 4; i++) {
    await page.keyboard.press("Control+v");
    await page.waitForTimeout(80);
  }
  const at4 = await page.evaluate(() => JSON.stringify(window.__paintpad.historyEntries()).length);
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press("Control+v");
    await page.waitForTimeout(80);
  }
  const at8 = await page.evaluate(() => JSON.stringify(window.__paintpad.historyEntries()).length);

  // Linear would be 2x for twice the pastes. Exponential would be far worse.
  expect(at8).toBeLessThan(at4 * 3);
});
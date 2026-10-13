import { expect, test, type Page } from "@playwright/test";
import { canvasLocator, clearCanvas, documentPixels, drawStroke, setTool, setWidth } from "./helpers";

/**
 * The selection highlight, drawn as a layer above the canvas.
 *
 * The dim lives on the overlay, so it is purely a view concern and can never reach the
 * document, an export, or an autosave. That is the property worth asserting hardest: if it
 * regresses, every save silently bakes a darkened canvas into the user's drawing.
 *
 * Assertions compare the COMPOSITED view against the DOCUMENT raster at the same point. The
 * dim adds coverage to whatever is underneath, so alpha is the reliable signal — guessing at
 * colour values is brittle, since empty canvas is fully transparent and dimming it makes it
 * lighter, not darker.
 */

const readout = (page: Page) => page.getByTestId("selection-readout");
const recordCount = (page: Page) => page.evaluate(() => window.__paintpad.settings().recordCount);

/** Alpha at a point in the composited view, which includes the overlay. */
function viewAlpha(page: Page, x: number, y: number): Promise<number> {
  return page.evaluate(
    ({ x, y }) => {
      const canvas = document.querySelector("canvas.surface") as HTMLCanvasElement;
      const rect = canvas.getBoundingClientRect();
      return canvas
        .getContext("2d")!
        .getImageData(
          Math.round((x / rect.width) * canvas.width),
          Math.round((y / rect.height) * canvas.height),
          1,
          1,
        ).data[3]!;
    },
    { x, y },
  );
}

/** Alpha at the same point in the artwork raster, which must never see the dim. */
function documentAlpha(page: Page, x: number, y: number): Promise<number> {
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
      // CSS coordinates in, raster coordinates sampled. The document is 2560x1440 while the
      // canvas is displayed smaller, so passing the CSS point straight through samples a
      // different pixel entirely.
      const surface = document.querySelector("canvas.surface") as HTMLCanvasElement;
      const rect = surface.getBoundingClientRect();
      return cx.getImageData(
        Math.round((x / rect.width) * img.width),
        Math.round((y / rect.height) * img.height),
        1,
        1,
      ).data[3]!;
    },
    { x, y },
  );
}

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
  await page.waitForTimeout(150);
}

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

test("the highlight dims everything except the selection", async ({ page }) => {
  await band(page);
  await setTool(page, "select");
  await drag(page, { x: 250, y: 230 }, { x: 650, y: 370 });

  // Inside the selection the view matches the document exactly — nothing dimmed.
  expect(await viewAlpha(page, 450, 300)).toBe(await documentAlpha(page, 450, 300));
  // Far outside it, the view has picked up coverage the document does not have.
  const outsideView = await viewAlpha(page, 120, 500);
  const outsideDoc = await documentAlpha(page, 120, 500);
  expect(outsideView).toBeGreaterThan(outsideDoc);
});

test("the highlight never reaches the document, a record, or an export", async ({ page }) => {
  await band(page);
  const documentBefore = await documentPixels(page);
  const countBefore = await recordCount(page);

  await setTool(page, "select");
  await drag(page, { x: 250, y: 230 }, { x: 650, y: 370 });

  expect(await documentPixels(page)).toEqual(documentBefore);
  expect(await recordCount(page)).toBe(countBefore);
});

test("the highlight disappears with the selection", async ({ page }) => {
  await band(page);
  await setTool(page, "select");
  await drag(page, { x: 250, y: 230 }, { x: 650, y: 370 });
  const dimmed = await viewAlpha(page, 120, 500);

  await setTool(page, "pencil");
  await page.waitForTimeout(150);

  // Back to matching the document: the dim is gone.
  expect(await viewAlpha(page, 120, 500)).toBe(await documentAlpha(page, 120, 500));
  expect(await viewAlpha(page, 120, 500)).toBeLessThan(dimmed);
  await expect(readout(page)).toHaveText("No selection");
});

test("the highlight follows the selection as it moves", async ({ page }) => {
  await band(page);
  await setTool(page, "select");
  await drag(page, { x: 250, y: 230 }, { x: 650, y: 370 });
  await drag(page, { x: 450, y: 300 }, { x: 450, y: 460 });
  await page.waitForTimeout(180);

  // The highlight now surrounds the moved band, not the original position.
  expect(await viewAlpha(page, 450, 460)).toBe(await documentAlpha(page, 450, 460));
  expect(await viewAlpha(page, 450, 300)).toBeGreaterThan(await documentAlpha(page, 450, 300));
});

test("no selection means no highlight", async ({ page }) => {
  await band(page);
  await setTool(page, "select");
  await page.waitForTimeout(120);
  // Nothing selected yet, so view and document agree everywhere.
  expect(await viewAlpha(page, 450, 300)).toBe(await documentAlpha(page, 450, 300));
  expect(await viewAlpha(page, 120, 500)).toBe(await documentAlpha(page, 120, 500));
});
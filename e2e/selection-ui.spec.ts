import { expect, test, type Page } from "@playwright/test";
import { canvasLocator, clearCanvas, documentPixels, drawStroke, setTool, setWidth } from "./helpers";

/**
 * Selection visibility.
 *
 * The dashed marquee is easy to miss, and Delete / Copy / Cut were reachable only by
 * keyboard with nothing on screen suggesting they existed. These cover the readout and the
 * buttons that make both discoverable.
 */

const readout = (page: Page) => page.getByTestId("selection-readout");
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

test("the readout says there is no selection to begin with", async ({ page }) => {
  await expect(readout(page)).toHaveText("No selection");
  await expect(page.getByRole("button", { name: "Delete", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Copy", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Cut", exact: true })).toBeDisabled();
});

test("the readout shows the selected size once there is one", async ({ page }) => {
  await band(page);
  // Pin 1:1 first. The selection is stored in document raster coordinates, so at fit-to-stage
  // a 200px drag on screen covers more than 200 document pixels — correct, but it makes the
  // number untestable without fixing the zoom.
  await page.getByRole("button", { name: "1:1" }).click();
  await page.waitForTimeout(120);

  await setTool(page, "select");
  await drag(page, { x: 250, y: 230 }, { x: 450, y: 370 });

  // Reported in document pixels: the region Delete and Export operate on, not the screen
  // size of the marquee. Within a pixel or so of the 200x140 drag — `normalizeRect` floors
  // the min and ceils the max so a selection always covers what was drawn over, which rounds
  // outward when an endpoint lands on a fractional raster coordinate.
  const text = (await readout(page).textContent()) ?? "";
  const size = /Selection (\d+) × (\d+)/.exec(text);
  expect(size).not.toBeNull();
  expect(Number(size![1])).toBeGreaterThanOrEqual(198);
  expect(Number(size![1])).toBeLessThanOrEqual(202);
  expect(Number(size![2])).toBeGreaterThanOrEqual(138);
  expect(Number(size![2])).toBeLessThanOrEqual(142);

  await expect(page.getByRole("button", { name: "Delete", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Copy", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Cut", exact: true })).toBeEnabled();
});

test("the readout reports the document size, which differs from the screen size", async ({ page }) => {
  // Worth pinning: the number is NOT the width of the box you dragged on screen. It is the
  // region in document space, which is what an export would crop.
  await band(page);
  await setTool(page, "select");
  await drag(page, { x: 250, y: 230 }, { x: 450, y: 370 });

  const text = (await readout(page).textContent()) ?? "";
  const size = /(\d+) × (\d+)/.exec(text);
  expect(size).not.toBeNull();
  // Fit-to-stage scales the canvas down, so the document region is strictly larger than the
  // 200 x 140 that was dragged on screen.
  expect(Number(size![1])).toBeGreaterThan(200);
  expect(Number(size![2])).toBeGreaterThan(140);
});

test("the readout clears when the selection does", async ({ page }) => {
  await band(page);
  await setTool(page, "select");
  await page.getByRole("button", { name: "1:1" }).click();
  await page.waitForTimeout(120);
  await drag(page, { x: 250, y: 230 }, { x: 450, y: 370 });
  await expect(readout(page)).toHaveText(/^Selection \d+ × \d+$/);

  // Switching tools drops the selection, and the chrome must say so.
  await setTool(page, "pencil");
  await expect(readout(page)).toHaveText("No selection");
  await expect(page.getByRole("button", { name: "Delete", exact: true })).toBeDisabled();
});

test("the readout clears after a click without a drag", async ({ page }) => {
  await band(page);
  await setTool(page, "select");
  await drag(page, { x: 250, y: 230 }, { x: 450, y: 370 });
  const box = (await canvasLocator(page).boundingBox())!;
  await page.mouse.move(box.x + 800, box.y + 500);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(120);

  await expect(readout(page)).toHaveText("No selection");
});

test("the toolbar Delete button does what the key does", async ({ page }) => {
  await band(page);
  const before = await ink(page);

  await setTool(page, "select");
  await drag(page, { x: 250, y: 230 }, { x: 450, y: 370 });
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.waitForTimeout(200);

  expect(await ink(page)).toBeLessThan(before);
  // Still selected afterwards, matching the Delete key.
  await expect(readout(page)).toHaveText(/^Selection/);
});

test("the toolbar Copy button fills the clipboard for paste", async ({ page }) => {
  await band(page);
  const before = await documentPixels(page);

  await setTool(page, "select");
  await drag(page, { x: 250, y: 230 }, { x: 450, y: 370 });
  await page.getByRole("button", { name: "Copy", exact: true }).click();
  await page.waitForTimeout(120);
  await page.keyboard.press("Control+v");
  await page.waitForTimeout(200);

  expect(await documentPixels(page)).not.toEqual(before);
});
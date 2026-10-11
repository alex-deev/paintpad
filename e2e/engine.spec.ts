import { expect, test } from "@playwright/test";
import { canvasLocator, clearCanvas, drawStroke, setTool, setWidth } from "./helpers";

/**
 * Behavioural tests. These assert *semantics* (record counts, gesture integrity) rather
 * than pixels; the goldens in `goldens.spec.ts` cover appearance, and `undo.spec.ts`
 * covers history.
 *
 * The `window.__paintpad` type is declared once in `helpers.ts` — do not redeclare it here.
 */

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(canvasLocator(page)).toBeVisible();
  await clearCanvas(page);
});

test("boots without console errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));

  await page.reload();
  await expect(canvasLocator(page)).toBeVisible();
  await page.waitForTimeout(150);

  expect(errors).toEqual([]);
});

test("one gesture commits exactly one record", async ({ page }) => {
  await setWidth(page, 6);
  await drawStroke(page, { x: 50, y: 50 }, { x: 300, y: 200 }, { steps: 20 });
  expect(await page.evaluate(() => window.__paintpad.recordCount)).toBe(1);
});

test("a tap still commits exactly one record", async ({ page }) => {
  await drawStroke(page, { x: 150, y: 150 }, { x: 150, y: 150 }, { steps: 1 });
  expect(await page.evaluate(() => window.__paintpad.recordCount)).toBe(1);
});

test("hovering commits nothing", async ({ page }) => {
  const box = (await canvasLocator(page).boundingBox())!;
  for (let i = 0; i < 15; i++) {
    await page.mouse.move(box.x + 30 + i * 20, box.y + 40 + i * 12);
  }
  await page.waitForTimeout(80);
  expect(await page.evaluate(() => window.__paintpad.recordCount)).toBe(0);
});

test("a stray second pointer does not create an extra record", async ({ page }) => {
  const box = (await canvasLocator(page).boundingBox())!;
  await page.mouse.move(box.x + 50, box.y + 250);
  await page.mouse.down();
  await page.mouse.move(box.x + 200, box.y + 200);
  await page.mouse.move(box.x + 350, box.y + 60, { steps: 3 });
  await page.mouse.up();
  await page.waitForTimeout(80);

  expect(await page.evaluate(() => window.__paintpad.recordCount)).toBe(1);
});

test("the eraser commits records like any other tool", async ({ page }) => {
  await setWidth(page, 12);
  await drawStroke(page, { x: 40, y: 150 }, { x: 340, y: 150 }, { steps: 15 });
  await setTool(page, "eraser");
  await drawStroke(page, { x: 150, y: 90 }, { x: 150, y: 210 }, { steps: 15 });

  expect(await page.evaluate(() => window.__paintpad.recordCount)).toBe(2);
});

test("the canvas fits inside the stage so coordinates stay honest", async ({ page }) => {
  // `overflow: hidden` truncates a canvas taller than the stage, and `boundingBox()` still
  // reports the unclipped rect — so an unfitted canvas silently eats input near its top.
  const fits = await page.evaluate(() => {
    const canvas = document.querySelector("canvas.surface")!.getBoundingClientRect();
    const stage = document.querySelector(".stage")!.getBoundingClientRect();
    return {
      insideVertically: canvas.top >= stage.top - 0.5 && canvas.bottom <= stage.bottom + 0.5,
      insideHorizontally: canvas.left >= stage.left - 0.5 && canvas.right <= stage.right + 0.5,
    };
  });
  expect(fits.insideVertically).toBe(true);
  expect(fits.insideHorizontally).toBe(true);
});

test("ink counting distinguishes a blank document from a drawn one", async ({ page }) => {
  // Guards the guard: several tests assert ink > N so that a blank render cannot pass an
  // equality comparison vacuously. That only holds if a blank canvas really reports zero.
  expect(await page.evaluate(() => window.__paintpad.documentInkCount())).toBe(0);

  await setWidth(page, 10);
  await drawStroke(page, { x: 60, y: 60 }, { x: 380, y: 260 }, { steps: 20 });

  const ink = await page.evaluate(() => window.__paintpad.documentInkCount());
  expect(ink).toBeGreaterThan(0);

  // Erasing everything back to background returns it to zero.
  await page.evaluate(() => window.__paintpad.reset());
  await page.waitForTimeout(80);
  expect(await page.evaluate(() => window.__paintpad.documentInkCount())).toBe(0);
});

test("the zoom readout tracks the viewport", async ({ page }) => {
  // Attaches fitted, so the initial zoom is at most 100%.
  const initial = await page.evaluate(() => window.__paintpad.settings().viewport.zoom);
  expect(initial).toBeLessThanOrEqual(1);

  await page.getByRole("button", { name: "1:1" }).click();
  await expect(page.locator(".zoom")).toHaveText("100%");
  await page.getByRole("button", { name: "+", exact: true }).click();
  await expect(page.locator(".zoom")).toHaveText("125%");
  await page.getByRole("button", { name: "Fit" }).click();
  const fitted = await page.evaluate(() => window.__paintpad.settings().viewport.zoom);
  expect(fitted).toBeLessThanOrEqual(1);
});

test("strokes survive a zoom round trip", async ({ page }) => {
  // Regression guard: zooming must not resample or clear committed pixels.
  await setWidth(page, 10);
  await drawStroke(page, { x: 60, y: 60 }, { x: 380, y: 260 }, { steps: 25 });
  const before = await page.evaluate(() => window.__paintpad.snapshotDataUrl?.() ?? null);

  for (let i = 0; i < 4; i++) await page.getByRole("button", { name: "+", exact: true }).click();
  for (let i = 0; i < 4; i++) await page.getByRole("button", { name: "−", exact: true }).click();
  await page.waitForTimeout(120);

  const after = await page.evaluate(() => window.__paintpad.snapshotDataUrl?.() ?? null);
  expect(after).toBe(before);
});
import { expect, test, type Page } from "@playwright/test";
import { canvasLocator, clearCanvas, documentPixels, drawStroke, setTool, setWidth } from "./helpers";

/**
 * Rectangular selection — marquee and delete.
 *
 * The claim this suite exists to check is that a *pixel-shaped* operation can still be
 * expressed as a parameter replayed onto the base. Delete is the simplest such operation;
 * if it cannot be, move and paste cannot be either.
 */

const ink = (page: Page) => page.evaluate(() => window.__paintpad.documentInkCount());
const recordCount = (page: Page) => page.evaluate(() => window.__paintpad.settings().recordCount);
const hasSelection = (page: Page) => page.evaluate(() => window.__paintpad.settings().hasSelection);

/** Drag a marquee between two CSS points. */
async function marquee(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  const box = (await canvasLocator(page).boundingBox())!;
  await page.mouse.move(box.x + from.x, box.y + from.y);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) {
    const t = i / 6;
    await page.mouse.move(
      box.x + from.x + (to.x - from.x) * t,
      box.y + from.y + (to.y - from.y) * t,
    );
  }
  await page.mouse.up();
  await page.waitForTimeout(80);
}

/** A wide, thick, solid horizontal band to cut into. */
async function band(page: Page): Promise<void> {
  await setTool(page, "pencil");
  await setWidth(page, 30);
  await page.getByTestId("swatch-foreground").click();
  await page.locator('button[data-colour="#000000"]').click();
  await drawStroke(page, { x: 120, y: 300 }, { x: 700, y: 300 }, { steps: 24 });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(canvasLocator(page)).toBeVisible();
  await page.evaluate(() => localStorage.clear());
  await clearCanvas(page);
});

test("delete removes the selected pixels and leaves the rest untouched", async ({ page }) => {
  await band(page);
  const before = await ink(page);
  expect(await hasSelection(page)).toBe(false);

  await setTool(page, "select");
  await marquee(page, { x: 300, y: 200 }, { x: 420, y: 400 });
  expect(await hasSelection(page)).toBe(true);

  await page.keyboard.press("Delete");
  await page.waitForTimeout(200);

  // A 120x200 CSS cut out of a 30px-wide band leaves most of it standing.
  const after = await ink(page);
  expect(after).toBeLessThan(before);
  expect(after).toBeGreaterThan(before * 0.5);
});

test("the deletion is a record, so undo restores it byte-identically", async ({ page }) => {
  await band(page);
  const beforeDelete = await documentPixels(page);

  await setTool(page, "select");
  await marquee(page, { x: 300, y: 200 }, { x: 420, y: 400 });
  await page.keyboard.press("Delete");
  await page.waitForTimeout(200);

  const deleted = await documentPixels(page);
  expect(deleted).not.toEqual(beforeDelete);
  expect(await recordCount(page)).toBe(2);

  await page.evaluate(() => window.__paintpad.undo());
  await page.waitForTimeout(200);
  // Undo moves the cursor, not the entry list, so `recordCount` stays at 2.
  expect(await documentPixels(page)).toEqual(beforeDelete);
  expect(await recordCount(page)).toBe(2);

  await page.evaluate(() => window.__paintpad.redo());
  await page.waitForTimeout(200);
  expect(await documentPixels(page)).toEqual(deleted);
});

test("the deletion survives a reload, because it is a record", async ({ page }) => {
  await band(page);
  await setTool(page, "select");
  await marquee(page, { x: 300, y: 200 }, { x: 420, y: 400 });
  await page.keyboard.press("Delete");
  await page.waitForTimeout(600);

  const before = await documentPixels(page);
  await page.reload();
  await expect(canvasLocator(page)).toBeVisible();
  await page.waitForTimeout(250);

  expect(await documentPixels(page)).toEqual(before);
});

test("the record stores a rect, not pixels", async ({ page }) => {
  // The whole design rests on this. An ImageData payload would survive JSON.stringify as an
  // empty object and silently corrupt every autosave containing one.
  await band(page);
  await setTool(page, "select");
  await marquee(page, { x: 300, y: 200 }, { x: 420, y: 400 });
  await page.keyboard.press("Delete");
  await page.waitForTimeout(200);

  const records = await page.evaluate(() => window.__paintpad.historyEntries());
  const clear = records[1]!;
  if (clear.kind !== "clearRect") throw new Error("expected a clearRect record");

  expect(clear.rect.width).toBeGreaterThan(0);
  expect(clear.rect.height).toBeGreaterThan(0);
  expect(Number.isInteger(clear.rect.x)).toBe(true);
  expect(Number.isInteger(clear.rect.width)).toBe(true);
  expect(JSON.parse(JSON.stringify(clear))).toEqual(clear);
});

test("a click without a drag clears the selection and records nothing", async ({ page }) => {
  await band(page);
  await setTool(page, "select");
  await marquee(page, { x: 200, y: 200 }, { x: 400, y: 400 });
  expect(await hasSelection(page)).toBe(true);

  const before = await recordCount(page);
  const box = (await canvasLocator(page).boundingBox())!;
  await page.mouse.move(box.x + 900, box.y + 500);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(120);

  expect(await hasSelection(page)).toBe(false);
  expect(await recordCount(page)).toBe(before);
});

test("Delete with no selection does nothing at all", async ({ page }) => {
  await band(page);
  const before = await recordCount(page);
  const pixels = await documentPixels(page);

  await page.keyboard.press("Delete");
  await page.waitForTimeout(150);

  expect(await recordCount(page)).toBe(before);
  expect(await documentPixels(page)).toEqual(pixels);
});

test("switching tools clears the selection", async ({ page }) => {
  await band(page);
  await setTool(page, "select");
  await marquee(page, { x: 200, y: 200 }, { x: 400, y: 400 });
  expect(await hasSelection(page)).toBe(true);

  await setTool(page, "pencil");
  expect(await hasSelection(page)).toBe(false);

  // And Delete must not now erase something the user can no longer see.
  const pixels = await documentPixels(page);
  await page.keyboard.press("Delete");
  await page.waitForTimeout(150);
  expect(await documentPixels(page)).toEqual(pixels);
});

test("the selection stays active after a delete, and a second delete extends the cut", async ({ page }) => {
  // Paint keeps the selection so Delete can be pressed again, and so undo leaves you with
  // the region still marked.
  await band(page);
  await setTool(page, "select");
  await marquee(page, { x: 250, y: 200 }, { x: 350, y: 400 });
  await page.keyboard.press("Delete");
  await page.waitForTimeout(200);
  expect(await hasSelection(page)).toBe(true);

  await marquee(page, { x: 550, y: 200 }, { x: 650, y: 400 });
  await page.keyboard.press("Delete");
  await page.waitForTimeout(200);

  expect(await recordCount(page)).toBe(3);
});

test("the marquee survives a zoom round trip", async ({ page }) => {
  await band(page);
  await setTool(page, "select");
  await marquee(page, { x: 300, y: 200 }, { x: 420, y: 400 });

  for (let i = 0; i < 4; i++) await page.getByRole("button", { name: "+", exact: true }).click();
  for (let i = 0; i < 4; i++) await page.getByRole("button", { name: "−", exact: true }).click();
  await page.waitForTimeout(160);

  // Still selected, and still selecting the same document region.
  expect(await hasSelection(page)).toBe(true);
  await page.keyboard.press("Delete");
  await page.waitForTimeout(200);
  expect(await recordCount(page)).toBe(2);
});

test("a marquee outside the canvas selects nothing and records nothing", async ({ page }) => {
  await band(page);
  await setTool(page, "select");
  const before = await recordCount(page);

  await marquee(page, { x: -40, y: -40 }, { x: -10, y: -10 });
  expect(await recordCount(page)).toBe(before);
});

test("deleting shows the background through the hole", async ({ page }) => {
  // The background is composited beneath the artwork, never baked in, so a cleared region
  // reveals it with no special handling.
  await page.getByTestId("swatch-background").click();
  await page.locator('button[data-colour="#ffd166"]').click();
  await band(page);

  await setTool(page, "select");
  await marquee(page, { x: 300, y: 200 }, { x: 420, y: 400 });
  await page.keyboard.press("Delete");
  await page.waitForTimeout(200);

  const box = (await canvasLocator(page).boundingBox())!;
  const sample = await page.evaluate(
    ({ x, y }) => {
      const canvas = document.querySelector("canvas.surface") as HTMLCanvasElement;
      const rect = canvas.getBoundingClientRect();
      const ctx = canvas.getContext("2d")!;
      const sx = Math.round((x / rect.width) * canvas.width);
      const sy = Math.round((y / rect.height) * canvas.height);
      return Array.from(ctx.getImageData(sx, sy, 1, 1).data);
    },
    { x: box.x ? 360 : 360, y: 300 },
  );
  // The view canvas shows the background, so the hole is opaque yellow, not transparent.
  expect(sample[3]).toBe(255);
  expect(sample[0]).toBe(255);
  expect(sample[1]).toBe(209);
});
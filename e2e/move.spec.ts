import { expect, test, type Page } from "@playwright/test";
import {
  canvasLocator,
  clearCanvas,
  documentPixels,
  drawStroke,
  setFill,
  setTool,
  setWidth,
} from "./helpers";

/**
 * Moving a selection.
 *
 * The claim under test: a move can be expressed as *parameters plus nested records* and
 * replayed, rather than as a stored picture of the region. If a move could not survive that,
 * cut-and-paste could not either.
 */

const recordCount = (page: Page) => page.evaluate(() => window.__paintpad.settings().recordCount);
const ink = (page: Page) => page.evaluate(() => window.__paintpad.documentInkCount());
const hasSelection = (page: Page) => page.evaluate(() => window.__paintpad.settings().hasSelection);

/** A drag with intermediate moves, so the live-preview path is exercised. */
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

/** A filled red block, so there is something with real pixels to carry around. */
async function block(page: Page, x: number, y: number): Promise<void> {
  await setTool(page, "rect");
  await setWidth(page, 4);
  await page.getByTestId("swatch-foreground").click();
  await page.locator('button[data-colour="#f72585"]').click();
  const box = (await canvasLocator(page).boundingBox())!;
  await page.mouse.move(box.x + x, box.y + y);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) {
    await page.mouse.move(box.x + x + (i * 100) / 6, box.y + y + (i * 80) / 6);
  }
  await page.mouse.up();
  await setFill(page, true);
  const box2 = (await canvasLocator(page).boundingBox())!;
  await page.mouse.move(box2.x + x, box2.y + y);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) {
    await page.mouse.move(box2.x + x + (i * 100) / 6, box2.y + y + (i * 80) / 6);
  }
  await page.mouse.up();
  await page.waitForTimeout(80);
}

/** Sample the composited view at a CSS point. */
async function sampleAt(page: Page, x: number, y: number): Promise<number[]> {
  return page.evaluate(
    ({ x, y }) => {
      const canvas = document.querySelector("canvas.surface") as HTMLCanvasElement;
      const rect = canvas.getBoundingClientRect();
      const ctx = canvas.getContext("2d")!;
      return Array.from(
        ctx.getImageData(
          Math.round((x / rect.width) * canvas.width),
          Math.round((y / rect.height) * canvas.height),
          1,
          1,
        ).data,
      );
    },
    { x, y },
  );
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(canvasLocator(page)).toBeVisible();
  await page.evaluate(() => localStorage.clear());
  await clearCanvas(page);
});

test("dragging inside the selection moves it; dragging outside makes a new one", async ({ page }) => {
  await setTool(page, "rect");
  await setWidth(page, 4);
  await page.getByTestId("swatch-foreground").click();
  await page.locator('button[data-colour="#f72585"]').click();
  const box = (await canvasLocator(page).boundingBox())!;
  await page.mouse.move(box.x + 200, box.y + 200);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(box.x + 200 + i * 40, box.y + 200 + i * 30);
  await page.mouse.up();

  await setTool(page, "select");
  await drag(page, { x: 180, y: 180 }, { x: 480, y: 420 });
  expect(await hasSelection(page)).toBe(true);
  const afterSelect = await recordCount(page);

  // From inside: a move, which commits a record.
  await drag(page, { x: 300, y: 300 }, { x: 400, y: 340 });
  expect(await recordCount(page)).toBe(afterSelect + 1);

  // From outside: a new selection, which commits nothing.
  await drag(page, { x: 700, y: 500 }, { x: 800, y: 560 });
  expect(await recordCount(page)).toBe(afterSelect + 1);
});

test("a move carries the pixels and leaves the source transparent", async ({ page }) => {
  await block(page, 200, 180);
  await setTool(page, "select");
  await drag(page, { x: 190, y: 170 }, { x: 320, y: 280 });
  await drag(page, { x: 255, y: 225 }, { x: 255, y: 420 });

  // The block has travelled down; the place it left is now empty.
  const source = await sampleAt(page, 250, 220);
  const destination = await sampleAt(page, 250, 415);
  expect(source[3]).toBe(0);
  expect(destination[0]).toBe(247);
  expect(destination[3]).toBe(255);
});

test("a move is a record holding nested records, not pixels", async ({ page }) => {
  // The whole design rests on this. An ImageData payload survives JSON.stringify as an empty
  // object and silently corrupts the autosave.
  await setTool(page, "pencil");
  await setWidth(page, 24);
  await page.getByTestId("swatch-foreground").click();
  await page.locator('button[data-colour="#1b9e77"]').click();
  await drawStroke(page, { x: 250, y: 250 }, { x: 420, y: 380 }, { steps: 20 });

  await setTool(page, "select");
  await drag(page, { x: 200, y: 200 }, { x: 500, y: 450 });
  await drag(page, { x: 300, y: 300 }, { x: 380, y: 300 });

  const records = await page.evaluate(() => window.__paintpad.historyEntries());
  const move = records.find((record) => record.kind === "move");
  if (!move || move.kind !== "move") throw new Error("expected a move record");

  expect(move.dx).toBeGreaterThan(0);
  expect(move.dy).toBe(0);
  expect(Number.isInteger(move.dx)).toBe(true);
  expect(Array.isArray(move.records)).toBe(true);
  expect(JSON.parse(JSON.stringify(move))).toEqual(move);

  // JSON-serialisable end to end, and no megabytes of base64 hiding in it.
  const json = JSON.stringify(move);
  expect(json.length).toBeLessThan(20_000);
});

test("undo restores a move byte-identically, and redo reapplies it", async ({ page }) => {
  await setTool(page, "pencil");
  await setWidth(page, 24);
  await page.getByTestId("swatch-foreground").click();
  await page.locator('button[data-colour="#1b9e77"]').click();
  await drawStroke(page, { x: 250, y: 250 }, { x: 420, y: 380 }, { steps: 20 });

  await setTool(page, "select");
  await drag(page, { x: 200, y: 200 }, { x: 500, y: 450 });
  const before = await documentPixels(page);
  await drag(page, { x: 300, y: 300 }, { x: 380, y: 300 });
  const moved = await documentPixels(page);
  expect(moved).not.toEqual(before);

  await page.evaluate(() => window.__paintpad.undo());
  await page.waitForTimeout(250);
  expect(await documentPixels(page)).toEqual(before);

  await page.evaluate(() => window.__paintpad.redo());
  await page.waitForTimeout(250);
  expect(await documentPixels(page)).toEqual(moved);
});

test("a move survives a reload", async ({ page }) => {
  await setTool(page, "pencil");
  await setWidth(page, 24);
  await page.getByTestId("swatch-foreground").click();
  await page.locator('button[data-colour="#1b9e77"]').click();
  await drawStroke(page, { x: 250, y: 250 }, { x: 420, y: 380 }, { steps: 20 });

  await setTool(page, "select");
  await drag(page, { x: 200, y: 200 }, { x: 500, y: 450 });
  await drag(page, { x: 300, y: 300 }, { x: 380, y: 300 });
  await page.waitForTimeout(700);

  const before = await documentPixels(page);
  await page.reload();
  await expect(canvasLocator(page)).toBeVisible();
  await page.waitForTimeout(250);
  expect(await documentPixels(page)).toEqual(before);
});

test("a move that ends where it started records nothing", async ({ page }) => {
  await setTool(page, "pencil");
  await setWidth(page, 20);
  await page.getByTestId("swatch-foreground").click();
  await page.locator('button[data-colour="#1b9e77"]').click();
  await drawStroke(page, { x: 250, y: 250 }, { x: 420, y: 380 }, { steps: 16 });

  await setTool(page, "select");
  await drag(page, { x: 200, y: 200 }, { x: 500, y: 450 });
  const before = await recordCount(page);
  await drag(page, { x: 300, y: 300 }, { x: 300, y: 300 });

  expect(await recordCount(page)).toBe(before);
});

test("only records touching the region are carried, not the whole log", async ({ page }) => {
  // Bounds filtering is what stops history growing multiplicatively.
  await setTool(page, "pencil");
  await setWidth(page, 16);
  await page.getByTestId("swatch-foreground").click();
  await page.locator('button[data-colour="#1b9e77"]').click();

  // Two strokes: one inside the selection area, one far away.
  await drawStroke(page, { x: 250, y: 250 }, { x: 420, y: 380 }, { steps: 16 });
  await drawStroke(page, { x: 800, y: 480 }, { x: 980, y: 600 }, { steps: 16 });

  await setTool(page, "select");
  await drag(page, { x: 200, y: 200 }, { x: 500, y: 450 });
  await drag(page, { x: 300, y: 300 }, { x: 360, y: 340 });

  const move = (await page.evaluate(() => window.__paintpad.historyEntries()))[2]!;
  if (move.kind !== "move") throw new Error("expected a move");

  // Only the stroke inside the clip is carried; the far one is left where it was.
  expect(move.records).toHaveLength(1);
  const untouched = await sampleAt(page, 890, 540);
  expect(untouched[3]).toBe(255);
});

test("moving the same selection twice conserves every pixel", async ({ page }) => {
  // The regression that motivated the scratch pool. A second move of the same selection
  // nests the first move record, so `applyMove` re-enters itself. Sharing one scratch
  // surface resized it mid-render and duplicated artwork: 29,561 pixels became 41,588.
  // A move moves pixels; it must never create them.
  await setTool(page, "pencil");
  await setWidth(page, 24);
  await page.getByTestId("swatch-foreground").click();
  await page.locator('button[data-colour="#1b9e77"]').click();
  await drawStroke(page, { x: 300, y: 300 }, { x: 500, y: 400 }, { steps: 20 });

  const start = await ink(page);
  await setTool(page, "select");
  await drag(page, { x: 260, y: 260 }, { x: 540, y: 440 });
  await drag(page, { x: 400, y: 350 }, { x: 400, y: 250 });
  expect(await ink(page)).toBe(start);
  await drag(page, { x: 400, y: 250 }, { x: 400, y: 400 });
  expect(await ink(page)).toBe(start);

  // And the second move really did nest the first, or this proves nothing.
  const moves = (await page.evaluate(() => window.__paintpad.historyEntries())).filter(
    (record) => record.kind === "move",
  );
  expect(moves).toHaveLength(2);
  expect(moves[1]!.records.some((record) => record.kind === "move")).toBe(true);

  await page.evaluate(() => {
    window.__paintpad.undo();
    window.__paintpad.undo();
  });
  await page.waitForTimeout(400);
  expect(await ink(page)).toBe(start);
});

test("a move carries a deleted region without resurrecting it", async ({ page }) => {
  // A selection spanning an earlier deletion nests that `clearRect`. Rendering it must use
  // the destination's transform, not force identity — under a nested replay the destination
  // is the outer move's translated scratch.
  await setTool(page, "pencil");
  await setWidth(page, 28);
  await page.getByTestId("swatch-foreground").click();
  await page.locator('button[data-colour="#1b9e77"]').click();
  await drawStroke(page, { x: 300, y: 300 }, { x: 600, y: 300 }, { steps: 24 });

  // Punch a gap in the middle of the band.
  await setTool(page, "select");
  await drag(page, { x: 380, y: 230 }, { x: 440, y: 370 });
  await page.keyboard.press("Delete");
  await page.waitForTimeout(200);
  const afterDelete = await ink(page);

  // Now take a region that spans the gap plus solid band on both sides, and carry it down.
  await drag(page, { x: 340, y: 230 }, { x: 520, y: 370 });
  await drag(page, { x: 430, y: 300 }, { x: 430, y: 420 });
  expect(await ink(page)).toBe(afterDelete);

  // The gap travelled with the band: solid either side of it, empty where it was.
  expect((await sampleAt(page, 360, 420))[3]).toBe(255);
  expect((await sampleAt(page, 410, 420))[3]).toBe(0);
  expect((await sampleAt(page, 500, 420))[3]).toBe(255);
  // And the band did not survive at its original position.
  expect((await sampleAt(page, 410, 300))[3]).toBe(0);
});

test("a move leaves the rest of the drawing alone", async ({ page }) => {
  await setTool(page, "pencil");
  await setWidth(page, 20);
  await page.getByTestId("swatch-foreground").click();
  await page.locator('button[data-colour="#1b9e77"]').click();
  await drawStroke(page, { x: 250, y: 250 }, { x: 420, y: 380 }, { steps: 16 });
  await drawStroke(page, { x: 850, y: 200 }, { x: 1000, y: 320 }, { steps: 16 });
  const inkBefore = await ink(page);

  await setTool(page, "select");
  await drag(page, { x: 200, y: 200 }, { x: 500, y: 450 });
  await drag(page, { x: 300, y: 300 }, { x: 300, y: 460 });

  // Moving preserves the pixel count: nothing added, nothing lost.
  expect(await ink(page)).toBe(inkBefore);
});
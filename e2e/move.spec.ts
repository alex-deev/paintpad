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

test("a move carries its region as a JSON-safe data URL", async ({ page }) => {
  // A retreat from "records are parameters", made on measurement: nesting the records that
  // produced a region was exact but duplicated exponentially — one stroke dragged ten times
  // was nested 1024 times over. A data URL is a string, so unlike `ImageData` it survives
  // JSON.stringify, which is the trap that has deferred image import twice.
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
  expect(move.image.startsWith("data:image/png")).toBe(true);
  // Survives a JSON round trip intact — the property `ImageData` fails.
  expect(JSON.parse(JSON.stringify(move))).toEqual(move);
  // And stays small: PNG compresses flat artwork well.
  expect(move.image.length).toBeLessThan(200_000);
});

test("history grows linearly with repeated moves, not exponentially", async ({ page }) => {
  // The reported symptom: re-selecting and moving repeatedly got slower and slower. Nesting
  // made each move embed the previous one, doubling the log every time — 1.3 MB after ten
  // moves, for a single stroke.
  await setTool(page, "pencil");
  await setWidth(page, 28);
  await page.getByTestId("swatch-foreground").click();
  await page.locator('button[data-colour="#1b9e77"]').click();
  await drawStroke(page, { x: 300, y: 300 }, { x: 600, y: 300 }, { steps: 24 });

  await setTool(page, "select");
  await drag(page, { x: 300, y: 230 }, { x: 400, y: 370 });

  const sizeAfterMove = async () => {
    await drag(page, { x: 350, y: 300 }, { x: 350, y: 450 });
    return page.evaluate(() => JSON.stringify(window.__paintpad.historyEntries()).length);
  };

  await sizeAfterMove();
  await sizeAfterMove();
  await sizeAfterMove();
  const at3 = await sizeAfterMove();
  await sizeAfterMove();
  await sizeAfterMove();
  const at6 = await sizeAfterMove();

  // Doubling would give 16x over four more moves. Linear over a bounded region gives a small
  // multiple, not an exponential one.
  expect(at6).toBeLessThan(at3 * 3);
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

test("a move carries a deleted region without resurrecting it", async ({ page }) => {
  // The snapshot includes the gap, so the gap travels with the band rather than being filled
  // back in.
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
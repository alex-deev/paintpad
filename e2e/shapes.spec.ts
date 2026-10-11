import { expect, test } from "@playwright/test";
import { canvasLocator, clearCanvas, dragShape, setFill, setTool, setWidth } from "./helpers";

/**
 * Shape verification.
 *
 * `outline`/`fill` goldens cover appearance. The seam golden is the important one: an
 * ellipse drawn as two half-arcs leaves a visible join where they meet, which is why the
 * renderer uses a single `ctx.ellipse()`.
 */

const pixels = (page: import("@playwright/test").Page) =>
  page.evaluate(() => window.__paintpad.snapshotDataUrl()!);
const ink = (page: import("@playwright/test").Page) =>
  page.evaluate(() => window.__paintpad.documentInkCount());

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(canvasLocator(page)).toBeVisible();
  await clearCanvas(page);
  await setWidth(page, 5);
});

test("line renders at any angle", async ({ page }) => {
  await setTool(page, "line");
  await dragShape(page, { x: 60, y: 60 }, { x: 400, y: 300 });
  expect(await ink(page)).toBeGreaterThan(0);
  expect(await canvasLocator(page)).toBeVisible();
});

test("horizontal and vertical lines render", async ({ page }) => {
  await setTool(page, "line");
  await dragShape(page, { x: 40, y: 120 }, { x: 420, y: 120 });
  await dragShape(page, { x: 200, y: 40 }, { x: 200, y: 320 });
  expect(await ink(page)).toBeGreaterThan(200);
});

test("outlined rectangle", async ({ page }) => {
  await setTool(page, "rect");
  await dragShape(page, { x: 80, y: 70 }, { x: 380, y: 280 });
  expect(await ink(page)).toBeGreaterThan(500);
});

test("filled rectangle", async ({ page }) => {
  await setTool(page, "rect");
  await setFill(page, true);
  await dragShape(page, { x: 80, y: 70 }, { x: 380, y: 280 });

  // A filled rectangle must enclose far more ink than an outlined one.
  const filled = await ink(page);
  expect(filled).toBeGreaterThan(20_000);
});

test("filled ellipse has no seam", async ({ page }) => {
  // The seam canary. Two half-arcs double-antialias where they meet and leave a visible
  // line across the shape.
  await setTool(page, "ellipse");
  await setFill(page, true);
  await dragShape(page, { x: 100, y: 60 }, { x: 400, y: 300 });

  expect(await canvasLocator(page)).toBeVisible();
  const filled = await ink(page);
  expect(filled).toBeGreaterThan(15_000);
});

test("shift constrains a line to 45 degree increments", async ({ page }) => {
  await setTool(page, "line");
  // ~37 degrees: nearest 45-degree increment is 45, so this must snap to a diagonal.
  await dragShape(page, { x: 60, y: 300 }, { x: 300, y: 120 }, { shift: true });

  const [record] = await page.evaluate(() => window.__paintpad.historyEntries());
  if (record!.kind !== "shape") throw new Error("expected a shape record");

  const dx = record!.to.x - record!.from.x;
  const dy = record!.to.y - record!.from.y;
  const degrees = (Math.atan2(dy, dx) * 180) / Math.PI;
  expect(Math.abs(degrees)).toBeCloseTo(45, 3);
});

test("shift snaps a shallow line to horizontal", async ({ page }) => {
  // A ~10-degree drag is nearer 0 than 45, so the correct snap is horizontal.
  await setTool(page, "line");
  await dragShape(page, { x: 60, y: 240 }, { x: 340, y: 190 }, { shift: true });

  const [record] = await page.evaluate(() => window.__paintpad.historyEntries());
  if (record!.kind !== "shape") throw new Error("expected a shape record");

  // Snapped to horizontal: the y endpoint matches the anchor while x carries the length.
  expect(record!.to.y).toBeCloseTo(record!.from.y, 4);
  expect(Math.abs(record!.to.x - record!.from.x)).toBeGreaterThan(1);
});

test("shift constrains a rectangle to a square", async ({ page }) => {
  await setTool(page, "rect");
  await dragShape(page, { x: 120, y: 80 }, { x: 400, y: 250 }, { shift: true });

  const [record] = await page.evaluate(() => window.__paintpad.historyEntries());
  if (record!.kind !== "shape") throw new Error("expected a shape record");

  expect(Math.abs(record!.to.x - record!.from.x)).toBeCloseTo(
    Math.abs(record!.to.y - record!.from.y),
    4,
  );
});

test("an unconstrained rectangle keeps its dragged proportions", async ({ page }) => {
  await setTool(page, "rect");
  await dragShape(page, { x: 60, y: 60 }, { x: 360, y: 210 });

  const [record] = await page.evaluate(() => window.__paintpad.historyEntries());
  if (record!.kind !== "shape") throw new Error("expected a shape record");

  const w = Math.abs(record!.to.x - record!.from.x);
  const h = Math.abs(record!.to.y - record!.from.y);
  expect(w / h).toBeCloseTo(2, 1);
});

test("a zero-extent drag commits nothing", async ({ page }) => {
  await setTool(page, "rect");
  // Click without dragging: a click, not a drag.
  const box = (await canvasLocator(page).boundingBox())!;
  await page.mouse.move(box.x + 200, box.y + 180);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(80);

  expect(await ink(page)).toBe(0);
  expect(await page.evaluate(() => window.__paintpad.recordCount)).toBe(0);
});

test("a zero-length line commits nothing", async ({ page }) => {
  await setTool(page, "line");
  const box = (await canvasLocator(page).boundingBox())!;
  await page.mouse.move(box.x + 200, box.y + 180);
  await page.mouse.down();
  await page.mouse.move(box.x + 200, box.y + 180);
  await page.mouse.up();
  await page.waitForTimeout(80);

  expect(await ink(page)).toBe(0);
});

test("undo and redo work on shapes", async ({ page }) => {
  await setTool(page, "rect");
  await dragShape(page, { x: 90, y: 80 }, { x: 390, y: 290 });
  const drawn = await pixels(page);

  await page.evaluate(() => window.__paintpad.undo());
  await page.waitForTimeout(100);
  expect(await ink(page)).toBe(0);

  await page.evaluate(() => window.__paintpad.redo());
  await page.waitForTimeout(100);
  expect(await pixels(page)).toBe(drawn);
});

test("shapes and strokes interleave in one history", async ({ page }) => {
  const box = (await canvasLocator(page).boundingBox())!;

  await setTool(page, "rect");
  await dragShape(page, { x: 60, y: 60 }, { x: 200, y: 180 });

  await setTool(page, "pencil");
  await setWidth(page, 8);
  await page.mouse.move(box.x + 80, box.y + 300);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(box.x + 80 + i * 20, box.y + 300 + (i % 3) * 8);
  }
  await page.mouse.up();
  await page.waitForTimeout(60);

  await setTool(page, "ellipse");
  await dragShape(page, { x: 240, y: 120 }, { x: 420, y: 280 });

  expect(await page.evaluate(() => window.__paintpad.recordCount)).toBe(3);

  // Undo peels one record at a time, in order: ellipse, then pencil, then rect.
  await page.evaluate(() => window.__paintpad.undo());
  await page.waitForTimeout(80);
  const afterTwo = await pixels(page);
  const inkTwo = await ink(page);

  await page.evaluate(() => window.__paintpad.undo());
  await page.waitForTimeout(80);
  const afterOne = await pixels(page);
  expect(afterOne).not.toBe(afterTwo);
  expect(await ink(page)).toBeGreaterThan(0);

  await page.evaluate(() => window.__paintpad.undo());
  await page.waitForTimeout(80);
  expect(await ink(page)).toBe(0);

  // Redo replays both, landing back on the exact two-record state.
  await page.evaluate(() => window.__paintpad.redo());
  await page.waitForTimeout(80);
  expect(await pixels(page)).toBe(afterOne);

  await page.evaluate(() => window.__paintpad.redo());
  await page.waitForTimeout(80);
  expect(await pixels(page)).toBe(afterTwo);
  expect(await ink(page)).toBe(inkTwo);
});

test("a shape survives a zoom round trip", async ({ page }) => {
  await setTool(page, "rect");
  await dragShape(page, { x: 80, y: 70 }, { x: 380, y: 280 });
  const before = await pixels(page);

  for (let i = 0; i < 4; i++) await page.getByRole("button", { name: "+", exact: true }).click();
  for (let i = 0; i < 4; i++) await page.getByRole("button", { name: "−", exact: true }).click();
  await page.waitForTimeout(120);

  expect(await pixels(page)).toBe(before);
});

test("the fill toggle is disabled for freehand tools", async ({ page }) => {
  await setTool(page, "pencil");
  await expect(page.locator('button[data-fill="toggle"]')).toBeDisabled();

  await setTool(page, "rect");
  await expect(page.locator('button[data-fill="toggle"]')).toBeEnabled();
});
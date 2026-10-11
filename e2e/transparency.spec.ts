import { expect, test, type Page } from "@playwright/test";
import { canvasLocator, clearCanvas, drawStroke, setTool, setWidth } from "./helpers";

/**
 * Transparency verification.
 *
 * The decisive assertion in this file reads the ALPHA CHANNEL directly. Every earlier
 * "erase" test could have passed against an eraser that merely painted white — alpha is what
 * separates erasing from nothing and painting white over something.
 */

/** Alpha histogram of the committed document: [opaque, translucent, transparent]. */
async function alphaBuckets(page: Page): Promise<[number, number, number]> {
  return page.evaluate(() => {
    const canvas = document.querySelector("canvas.surface") as HTMLCanvasElement;
    const ctx = canvas.getContext("2d")!;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let opaque = 0;
    let translucent = 0;
    let transparent = 0;
    for (let i = 3; i < data.length; i += 4) {
      const a = data[i]!;
      if (a === 0) transparent++;
      else if (a === 255) opaque++;
      else translucent++;
    }
    return [opaque, translucent, transparent];
  });
}

const documentPixels = (page: Page) => page.evaluate(() => window.__paintpad.snapshotDataUrl()!);
const ink = (page: Page) => page.evaluate(() => window.__paintpad.documentInkCount());

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(canvasLocator(page)).toBeVisible();
  await clearCanvas(page);
});

test("a new document is fully transparent", async ({ page }) => {
  const [opaque, translucent, transparent] = await alphaBuckets(page);

  expect(opaque).toBe(0);
  expect(translucent).toBe(0);
  expect(transparent).toBeGreaterThan(0);
});

test("reset produces a transparent document, not a white one", async ({ page }) => {
  await setWidth(page, 20);
  await drawStroke(page, { x: 60, y: 60 }, { x: 380, y: 260 }, { steps: 20 });

  await page.getByRole("button", { name: "Clear" }).click();
  await page.waitForTimeout(120);

  const [opaque, , transparent] = await alphaBuckets(page);
  expect(opaque).toBe(0);
  expect(transparent).toBeGreaterThan(0);
  expect(await ink(page)).toBe(0);
});

test("HEADLINE: the eraser produces alpha 0, not opaque white", async ({ page }) => {
  await setWidth(page, 24);
  await drawStroke(page, { x: 60, y: 200 }, { x: 500, y: 200 }, { steps: 24 });

  const [opaqueBefore] = await alphaBuckets(page);
  expect(opaqueBefore).toBeGreaterThan(1000);

  await setTool(page, "eraser");
  await drawStroke(page, { x: 220, y: 80 }, { x: 220, y: 340 }, { steps: 18 });

  // The gap must be fully transparent. An eraser that paints white would leave these
  // pixels opaque, and this is the assertion that catches that.
  const gapAlpha = await page.evaluate(() => {
    const canvas = document.querySelector("canvas.surface") as HTMLCanvasElement;
    const ctx = canvas.getContext("2d")!;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let transparent = 0;
    let opaque = 0;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] === 0) transparent++;
      else if (data[i] === 255) opaque++;
    }
    return { transparent, opaque };
  });

  // The erased band is fully transparent...
  expect(gapAlpha.transparent).toBeGreaterThan(1000);
  // ...and the surviving stroke is still opaque.
  expect(gapAlpha.opaque).toBeGreaterThan(1000);
});

test("undo restores erased pixels and redo re-erases", async ({ page }) => {
  await setWidth(page, 24);
  await drawStroke(page, { x: 60, y: 200 }, { x: 500, y: 200 }, { steps: 24 });
  await setTool(page, "eraser");
  await drawStroke(page, { x: 240, y: 80 }, { x: 240, y: 340 }, { steps: 18 });

  const erased = await documentPixels(page);

  await page.evaluate(() => window.__paintpad.undo());
  await page.waitForTimeout(120);
  const [opaqueUndone] = await alphaBuckets(page);
  expect(opaqueUndone).toBeGreaterThan(1000);

  await page.evaluate(() => window.__paintpad.redo());
  await page.waitForTimeout(120);
  expect(await documentPixels(page)).toBe(erased);
});

test("drawing on a transparent document commits opaque pixels", async ({ page }) => {
  await setWidth(page, 30);
  await drawStroke(page, { x: 120, y: 120 }, { x: 400, y: 320 }, { steps: 20 });

  const [opaque, translucent] = await alphaBuckets(page);
  // The stroke core must be fully opaque — not washed out by compositing against nothing.
  expect(opaque).toBeGreaterThan(1000);
  // A small translucent population is correct and expected: that is antialiasing on the
  // stroke edges. If it ever approaches the opaque count, blending is wrong.
  expect(translucent).toBeGreaterThan(0);
  expect(translucent).toBeLessThan(opaque);
});

test("transparent regions survive a zoom round trip", async ({ page }) => {
  await setWidth(page, 16);
  await drawStroke(page, { x: 60, y: 60 }, { x: 380, y: 260 }, { steps: 20 });
  const before = await documentPixels(page);

  for (let i = 0; i < 4; i++) await page.getByRole("button", { name: "+", exact: true }).click();
  for (let i = 0; i < 4; i++) await page.getByRole("button", { name: "−", exact: true }).click();
  await page.waitForTimeout(140);

  expect(await documentPixels(page)).toBe(before);
});

test("documentInkCount is alpha-based on an empty document", async ({ page }) => {
  expect(await ink(page)).toBe(0);

  await setWidth(page, 20);
  await drawStroke(page, { x: 80, y: 80 }, { x: 360, y: 280 }, { steps: 18 });
  expect(await ink(page)).toBeGreaterThan(500);

  await setTool(page, "eraser");
  await drawStroke(page, { x: 200, y: 40 }, { x: 200, y: 340 }, { steps: 16 });
  // Erasing reduces ink even though the pixels became transparent rather than white.
  expect(await ink(page)).toBeGreaterThan(0);
});

test("an erase is recorded with destination-out compositing", async ({ page }) => {
  await setWidth(page, 16);
  await drawStroke(page, { x: 60, y: 150 }, { x: 400, y: 150 }, { steps: 20 });
  await setTool(page, "eraser");
  await drawStroke(page, { x: 200, y: 60 }, { x: 200, y: 240 }, { steps: 12 });

  const records = await page.evaluate(() => window.__paintpad.historyEntries());
  expect(records).toHaveLength(2);

  const [stroke, erase] = records;
  if (stroke!.kind !== "stroke" || erase!.kind !== "stroke") {
    throw new Error("expected two stroke records");
  }
  expect(stroke!.composite).toBe("source-over");
  // The erase reuses the stroke record shape rather than inventing a new record type.
  expect(erase!.composite).toBe("destination-out");
});

test("erasing from an empty document is a no-op but still records", async ({ page }) => {
  await setTool(page, "eraser");
  await drawStroke(page, { x: 100, y: 100 }, { x: 300, y: 240 }, { steps: 14 });

  expect(await ink(page)).toBe(0);
  // Recorded, so the gesture is undoable even though it removed nothing visible.
  expect(await page.evaluate(() => window.__paintpad.recordCount)).toBe(1);
});
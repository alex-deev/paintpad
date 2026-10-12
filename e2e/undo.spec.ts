import { expect, test, type Page } from "@playwright/test";
import { canvasLocator, clearCanvas, drawStroke, setTool, setWidth } from "./helpers";

/**
 * Undo/redo verification.
 *
 * The decisive test here is `replay identity`: the canvas is always derived by replaying
 * `visibleEntries(history)`. If live drawing and replay ever take different code paths, that
 * test fails immediately — and undo would silently show pixels the user never drew.
 */

const undoButton = (page: Page) => page.getByRole("button", { name: "Undo" });
const redoButton = (page: Page) => page.getByRole("button", { name: "Redo" });

const pixels = (page: Page) => page.evaluate(() => window.__paintpad.snapshotDataUrl()!);
const ink = (page: Page) => page.evaluate(() => window.__paintpad.documentInkCount());

async function drawThreeStrokes(page: Page) {
  await setWidth(page, 7);
  await drawStroke(page, { x: 40, y: 50 }, { x: 300, y: 200 }, { steps: 18 });
  await drawStroke(page, { x: 300, y: 50 }, { x: 420, y: 260 }, { steps: 12 });
  await drawStroke(page, { x: 60, y: 300 }, { x: 380, y: 160 }, { steps: 22 });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(canvasLocator(page)).toBeVisible();
  await clearCanvas(page);
});

test("replay identity: undoing to blank and redoing restores identical pixels", async ({ page }) => {
  await drawThreeStrokes(page);
  const drawn = await pixels(page);
  expect(await ink(page)).toBeGreaterThan(100);

  await page.evaluate(() => {
    for (let i = 0; i < 3; i++) window.__paintpad.undo();
  });
  await page.waitForTimeout(100);
  expect(await ink(page)).toBe(0);

  await page.evaluate(() => {
    for (let i = 0; i < 3; i++) window.__paintpad.redo();
  });
  await page.waitForTimeout(100);

  // Byte-identical, not merely "looks the same".
  expect(await pixels(page)).toBe(drawn);
});

test("undoing every stroke restores a pristine document", async ({ page }) => {
  await drawThreeStrokes(page);
  await page.evaluate(() => {
    for (let i = 0; i < 10; i++) window.__paintpad.undo();
  });
  await page.waitForTimeout(100);

  expect(await ink(page)).toBe(0);
  // The entries are deliberately retained so redo still works — what must be exhausted is
  // the undo cursor, not the history.
  expect(await page.evaluate(() => window.__paintpad.canUndo())).toBe(false);
  expect(await page.evaluate(() => window.__paintpad.canRedo())).toBe(true);
});

test("undo is lossless across many steps", async ({ page }) => {
  await drawThreeStrokes(page);
  const drawn = await pixels(page);

  await page.evaluate(() => window.__paintpad.undo());
  await page.waitForTimeout(60);
  const afterTwo = await pixels(page);
  expect(afterTwo).not.toBe(drawn);

  await page.evaluate(() => window.__paintpad.undo());
  await page.waitForTimeout(60);
  expect(await pixels(page)).not.toBe(afterTwo);

  await page.evaluate(() => {
    window.__paintpad.redo();
    window.__paintpad.redo();
  });
  await page.waitForTimeout(100);
  expect(await pixels(page)).toBe(drawn);
});

test("drawing after an undo discards the redo tail", async ({ page }) => {
  await drawThreeStrokes(page);
  await page.evaluate(() => {
    window.__paintpad.undo();
    window.__paintpad.undo();
  });
  await expect(redoButton(page)).toBeEnabled();

  await drawStroke(page, { x: 80, y: 80 }, { x: 360, y: 280 }, { steps: 15 });

  // The abandoned future must be gone, not merely hidden.
  await expect(redoButton(page)).toBeDisabled();
  expect(await page.evaluate(() => window.__paintpad.recordCount)).toBe(2);
});

test("undo restores pixels an eraser covered", async ({ page }) => {
  await setWidth(page, 20);
  await drawStroke(page, { x: 40, y: 150 }, { x: 420, y: 150 }, { steps: 20 });
  const beforeErase = await pixels(page);

  await setTool(page, "eraser");
  await drawStroke(page, { x: 180, y: 80 }, { x: 180, y: 230 }, { steps: 15 });
  expect(await pixels(page)).not.toBe(beforeErase);

  await page.evaluate(() => window.__paintpad.undo());
  await page.waitForTimeout(100);
  expect(await pixels(page)).toBe(beforeErase);
});

test("keyboard shortcuts drive undo and redo", async ({ page }) => {
  await drawThreeStrokes(page);
  const drawn = await pixels(page);

  await page.keyboard.press("Control+z");
  await page.waitForTimeout(80);
  expect(await pixels(page)).not.toBe(drawn);

  await page.keyboard.press("Control+Shift+z");
  await page.waitForTimeout(80);
  expect(await pixels(page)).toBe(drawn);

  await page.keyboard.press("Control+z");
  await page.waitForTimeout(80);
  await page.keyboard.press("Control+y");
  await page.waitForTimeout(80);
  expect(await pixels(page)).toBe(drawn);
});

test("undo and redo buttons reflect available history", async ({ page }) => {
  await expect(undoButton(page)).toBeDisabled();
  await expect(redoButton(page)).toBeDisabled();

  await drawThreeStrokes(page);
  await expect(undoButton(page)).toBeEnabled();
  await expect(redoButton(page)).toBeDisabled();

  await page.evaluate(() => {
    for (let i = 0; i < 3; i++) window.__paintpad.undo();
  });
  await expect(undoButton(page)).toBeDisabled();
  await expect(redoButton(page)).toBeEnabled();
});

test("replaying 1000 records completes without a perceptible hang", async ({ page }) => {
  // This is the evidence behind "no raster checkpoints": replay stays cheap enough that a
  // full-document rebuild is never worth a 14.7 MB checkpoint.
  //
  // The budget is deliberately NOT a frame budget. Undo/redo are discrete user actions, not
  // per-frame work, so the bar is "well under the ~100 ms where a user perceives a hang".
  //
  // Measured idle on this document size: 1000 records replay in roughly 40 ms. The ceiling is
  // set well above that because this is wall-clock inside a browser sharing a 4-core box with
  // another test worker and the dev server, where contention alone has been observed to push a
  // 40 ms replay past 105 ms. At 200 ms a real regression — anything the checkpoint decision
  // would actually change — still fails loudly.
  const elapsedMs = await page.evaluate(() => {
    const stroke = {
      kind: "stroke" as const,
      tool: "pencil" as const,
      composite: "source-over" as const,
      color: "#1f2430",
      width: 3,
      points: [
        { x: 10, y: 10 },
        { x: 40, y: 55 },
        { x: 70, y: 25 },
        { x: 100, y: 80 },
      ],
    };
    const records = Array.from({ length: 1000 }, () => stroke);

    const started = performance.now();
    window.__paintpad.loadRecords(records);
    return performance.now() - started;
  });

  expect(await ink(page)).toBeGreaterThan(0);
  expect(elapsedMs).toBeLessThan(200);
});

test("undo still works after interacting with the size slider", async ({ page }) => {
  // Regression guard: the slider must not swallow the keyboard layer. An earlier version
  // blocked every shortcut whenever an <input> had focus, so using the size control
  // silently disabled undo and the tool keys.
  await drawThreeStrokes(page);
  const drawn = await pixels(page);

  await page.locator('input[type="range"]').fill("12");
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(80);

  expect(await pixels(page)).not.toBe(drawn);
});

test("tool shortcuts still work after focusing the size slider", async ({ page }) => {
  await page.locator('input[type="range"]').fill("12");
  await page.keyboard.press("2");
  await expect(page.locator('button[data-tool="eraser"]')).toHaveAttribute("aria-pressed", "true");

  await page.keyboard.press("1");
  await expect(page.locator('button[data-tool="pencil"]')).toHaveAttribute("aria-pressed", "true");
});
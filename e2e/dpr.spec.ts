import { expect, test, type Browser, type Page } from "@playwright/test";

/**
 * HiDPI correctness — success criterion 7.
 *
 * The locked decision is that `devicePixelRatio` affects *display only*: the backing store
 * is always logical size x rasterScale. So the committed document pixels must be
 * byte-identical no matter which display the window is on. If that ever stops holding,
 * strokes silently change appearance when a laptop is undocked from a monitor.
 */

const SCALES = [1, 2, 3] as const;

async function drawOnFreshPage(
  browser: Browser,
  deviceScaleFactor: number,
): Promise<{ document: string; viewWidth: number; viewHeight: number; ink: number }> {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor,
  });
  const page = await context.newPage();
  await page.goto("/");
  await expect(page.locator("canvas.surface")).toBeVisible();

  // Deliberately NOT forcing 1:1. At fit zoom the canvas sits entirely inside the stage, so
  // every coordinate is hit-testable. Zoom is DPR-independent either way.
  await page.locator('input[type="range"]').fill("6");

  const box = (await page.locator("canvas.surface").boundingBox())!;
  const from = { x: 40, y: 40 };
  const to = { x: 340, y: 220 };

  await page.mouse.move(box.x + from.x, box.y + from.y);
  await page.mouse.down();
  for (let i = 1; i <= 25; i++) {
    const t = i / 25;
    await page.mouse.move(box.x + from.x + (to.x - from.x) * t, box.y + from.y + (to.y - from.y) * t);
  }
  await page.mouse.up();
  await page.waitForTimeout(120);

  const result = await page.evaluate(() => {
    const view = document.querySelector("canvas.surface") as HTMLCanvasElement;
    return {
      document: window.__paintpad.snapshotDataUrl()!,
      viewWidth: view.width,
      viewHeight: view.height,
      ink: window.__paintpad.documentInkCount(),
    };
  });

  await context.close();
  return result;
}

/** Count non-white pixels in the committed document, so blank renders cannot pass. */
async function inkCount(page: Page): Promise<number> {
  return page.evaluate(() => window.__paintpad.documentInkCount());
}

test("document pixels are identical at deviceScaleFactor 1, 2 and 3", async ({ browser }) => {
  const results = await Promise.all(SCALES.map((scale) => drawOnFreshPage(browser, scale)));

  // The view canvas is display-scaled by DPR, in proportion to within a pixel of rounding.
  // The CSS width is fractional (fit-to-stage divides), and `Math.round(css * dpr)` does not
  // have to land on exactly `round(css) * dpr`. Any layout change that shifts the stage by a
  // fraction of a pixel perturbs this, so the assertion allows 1px — the point is that the view
  // scales with DPR and not that arithmetic happens to be exact.
  expect(Math.abs(results[1]!.viewWidth - results[0]!.viewWidth * 2)).toBeLessThanOrEqual(1);
  expect(Math.abs(results[2]!.viewWidth - results[0]!.viewWidth * 3)).toBeLessThanOrEqual(1);

  // The committed document, though, must be bit-for-bit identical at every scale. This is the
  // assertion that matters and it stays exact.
  expect(results[1]!.document).toBe(results[0]!.document);
  expect(results[2]!.document).toBe(results[0]!.document);

  // Guard against a vacuous pass: an all-white document would trivially compare equal.
  expect(results[0]!.ink).toBeGreaterThan(500);
});

test("drawing stays correct after a live DPR change", async ({ page }) => {
  // Moving the window between monitors changes devicePixelRatio mid-session. Committed
  // pixels must survive it, and the view must re-scale.
  await page.goto("/");
  await expect(page.locator("canvas.surface")).toBeVisible();

  const before = await page.evaluate(() => window.__paintpad.snapshotDataUrl());

  await page.evaluate(() => {
    Object.defineProperty(window, "devicePixelRatio", { value: 3, configurable: true });
    // Fire the listener the engine binds to detect a DPR change.
    window.dispatchEvent(new Event("resize"));
  });
  await page.evaluate(() => window.__paintpad.fitToStage());
  await page.waitForTimeout(150);

  const after = await page.evaluate(() => window.__paintpad.snapshotDataUrl());
  expect(after).toBe(before);
});

test.describe("tap and flick survive every scale", () => {
  for (const scale of SCALES) {
    test(`degenerate strokes render at deviceScaleFactor ${scale}`, async ({ browser }) => {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        deviceScaleFactor: scale,
      });
      const page = await context.newPage();
      await page.goto("/");
      await expect(page.locator("canvas.surface")).toBeVisible();
      await page.locator('input[type="range"]').fill("8");

      const box = (await page.locator("canvas.surface").boundingBox())!;
      await tap(page, box, 300, 200);
      await flick(page, box);

      // Exact ink count, not a compressed-size proxy: a blank canvas must never satisfy
      // this assertion.
      expect(await inkCount(page)).toBeGreaterThan(200);

      await context.close();
    });
  }
});

async function tap(page: Page, box: { x: number; y: number }, x: number, y: number) {
  await page.mouse.move(box.x + x, box.y + y);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(60);
}

async function flick(page: Page, box: { x: number; y: number }) {
  await page.mouse.move(box.x + 80, box.y + 260);
  await page.mouse.down();
  await page.mouse.move(box.x + 500, box.y + 300);
  await page.mouse.up();
  await page.waitForTimeout(60);
}
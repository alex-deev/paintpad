import { expect, test, type Page } from "@playwright/test";
import { canvasLocator, clearCanvas, dragShape, drawStroke, setTool, setWidth } from "./helpers";

/**
 * Flood fill verification.
 *
 * The algorithm itself is covered exhaustively by the pure unit suite; these assert the
 * integration: that a fill reaches the canvas, that undo restores it, and that the fill
 * colour is baked into the record.
 */

const pixels = (page: Page) => page.evaluate(() => window.__paintpad.snapshotDataUrl()!);
const ink = (page: Page) => page.evaluate(() => window.__paintpad.documentInkCount());

async function fillAt(page: Page, x: number, y: number): Promise<void> {
  const box = (await canvasLocator(page).boundingBox())!;
  await page.mouse.move(box.x + x, box.y + y);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(140);
}

async function pickColour(page: Page, colour: string): Promise<void> {
  await page.getByTestId("swatch-foreground").click();
  await page.locator(`button[data-colour="${colour}"]`).click();
}

/** Draw a closed filled box, giving the fill something bounded to work with. */
async function closedBox(page: Page, colour: string) {
  await setTool(page, "rect");
  await pickColour(page, colour);
  await dragShape(page, { x: 140, y: 100 }, { x: 420, y: 300 });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(canvasLocator(page)).toBeVisible();
  await page.evaluate(() => localStorage.clear());
  await clearCanvas(page);
});

test("fill paints the enclosed region with the current colour", async ({ page }) => {
  await closedBox(page, "#000000");
  const before = await ink(page);

  await setTool(page, "fill");
  await pickColour(page, "#f72585");
  await fillAt(page, 280, 200);

  const after = await ink(page);
  // A filled interior adds far more pixels than the outline alone.
  expect(after).toBeGreaterThan(before + 20_000);
});

test("undo restores the pre-fill pixels byte-identically", async ({ page }) => {
  await closedBox(page, "#000000");
  const beforeFill = await pixels(page);

  await setTool(page, "fill");
  await pickColour(page, "#f72585");
  await fillAt(page, 280, 200);
  const afterFill = await pixels(page);
  expect(afterFill).not.toBe(beforeFill);

  await page.evaluate(() => window.__paintpad.undo());
  await page.waitForTimeout(160);
  expect(await pixels(page)).toBe(beforeFill);

  await page.evaluate(() => window.__paintpad.redo());
  await page.waitForTimeout(160);
  expect(await pixels(page)).toBe(afterFill);
  // Redo is spent once the tip of history is reached again.
  await expect(page.getByRole("button", { name: "Redo" })).toBeDisabled();
});

test("the fill record stores parameters, not pixels", async ({ page }) => {
  await closedBox(page, "#000000");
  await setTool(page, "fill");
  await pickColour(page, "#06d6a0");
  await fillAt(page, 280, 200);

  const records = await page.evaluate(() => window.__paintpad.historyEntries());
  const fill = records[1]!;
  if (fill.kind !== "fill") throw new Error("expected a fill record");

  // Parameters only — an ImageData payload would be silently destroyed by JSON.stringify.
  expect(fill.kind).toBe("fill");
  expect(fill.colour).toBe("#06d6a0");
  expect(fill.contiguous).toBe(true);
  expect(typeof fill.seed.x).toBe("number");
  expect(JSON.parse(JSON.stringify(fill))).toEqual(fill);
});

test("the fill colour is baked, so changing the palette does not affect old fills", async ({ page }) => {
  await closedBox(page, "#000000");
  await setTool(page, "fill");
  await pickColour(page, "#f72585");
  await fillAt(page, 280, 200);
  const afterFill = await pixels(page);

  await pickColour(page, "#06d6a0");

  await page.evaluate(() => window.__paintpad.undo());
  await page.waitForTimeout(120);
  await page.evaluate(() => window.__paintpad.redo());
  await page.waitForTimeout(160);

  expect(await pixels(page)).toBe(afterFill);
});

test("global mode fills every matching region, contiguous fills only the clicked one", async ({ page }) => {
  // Two closed boxes with nothing inside. Their interiors are both the same transparent
  // colour, so "every matching pixel" and "the connected region" genuinely differ here.
  await setTool(page, "rect");
  await setWidth(page, 8);
  await pickColour(page, "#000000");
  await dragShape(page, { x: 60, y: 60 }, { x: 200, y: 200 });
  await dragShape(page, { x: 300, y: 60 }, { x: 440, y: 200 });

  await setTool(page, "fill");
  await pickColour(page, "#4361ee");
  await fillAt(page, 130, 130);
  const contiguous = await ink(page);

  await page.getByTestId("fill-mode").click();
  await expect(page.getByTestId("fill-mode")).toHaveText("Global");
  // Undo first: a second fill seeded inside the region the first one just painted would be
  // filling blue with blue, and a no-op would prove nothing.
  await page.evaluate(() => window.__paintpad.undo());
  await page.waitForTimeout(160);
  await fillAt(page, 130, 130);
  const global = await ink(page);

  // Global additionally took the second box, so it painted strictly more.
  expect(global).toBeGreaterThan(contiguous + 20_000);
});

test("filling empty canvas fills the whole region, like Paint's background fill", async ({ page }) => {
  await setTool(page, "fill");
  await pickColour(page, "#11845b");
  await fillAt(page, 300, 200);

  // An empty document is transparent everywhere, so a contiguous fill covers all of it.
  expect(await ink(page)).toBeGreaterThan(500_000);
});

test("a fill does not disturb neighbouring regions", async ({ page }) => {
  await setTool(page, "rect");
  await setWidth(page, 8);
  await pickColour(page, "#000000");
  await dragShape(page, { x: 60, y: 60 }, { x: 220, y: 200 });
  await dragShape(page, { x: 320, y: 260 }, { x: 460, y: 380 });

  await setTool(page, "fill");
  await pickColour(page, "#f72585");
  await fillAt(page, 140, 130);

  // The second box was never filled — sampled at its centre it stays the outline colour.
  const sample = await page.evaluate(() => {
    const canvas = document.querySelector("canvas.surface") as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    const ctx = canvas.getContext("2d")!;
    const sx = Math.round((390 / rect.width) * canvas.width);
    const sy = Math.round((320 / rect.height) * canvas.height);
    return Array.from(ctx.getImageData(sx, sy, 1, 1).data);
  });
  expect(sample[3]).toBe(0); // still transparent — untouched by the fill
});

test("erased regions are fillable", async ({ page }) => {
  await closedBox(page, "#000000");
  await setTool(page, "eraser");
  await setWidth(page, 30);
  const box = (await canvasLocator(page).boundingBox())!;
  await page.mouse.move(box.x + 280, box.y + 60);
  await page.mouse.down();
  await page.mouse.move(box.x + 280, box.y + 340, { steps: 18 });
  await page.mouse.up();
  await page.waitForTimeout(140);

  await setTool(page, "fill");
  await pickColour(page, "#ffd166");
  await fillAt(page, 140, 200);

  expect(await ink(page)).toBeGreaterThan(20_000);
});

test("the fill-mode toggle is disabled unless the bucket is selected", async ({ page }) => {
  await expect(page.getByTestId("fill-mode")).toBeDisabled();
  await setTool(page, "fill");
  await expect(page.getByTestId("fill-mode")).toBeEnabled();
});

/**
 * Count partial-alpha pixels 4-adjacent to a pixel of `fillRgb`.
 *
 * These are the antialiased ramp between a fill and the line it was filled against. Every one
 * of them is a visible hairline between the fill colour and the wall.
 */
async function countAdjacentFringe(
  page: Page,
  [fr, fg, fb, fa]: number[],
): Promise<number> {
  return page.evaluate(
    async ({ fr, fg, fb, fa }) => {
      const img = new Image();
      img.src = window.__paintpad.snapshotDataUrl()!;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const cx = c.getContext("2d")!;
      cx.drawImage(img, 0, 0);
      const d = cx.getImageData(0, 0, c.width, c.height).data;
      const W = c.width;
      const H = c.height;
      const at = (x: number, y: number) => (y * W + x) * 4;
      const isFill = (x: number, y: number) => {
        const i = at(x, y);
        return d[i] === fr && d[i + 1] === fg && d[i + 2] === fb && d[i + 3] === fa;
      };

      let count = 0;
      for (let y = 1; y < H - 1; y++) {
        for (let x = 1; x < W - 1; x++) {
          const a = d[at(x, y) + 3]!;
          if (a === 0 || a === 255) continue;
          if (isFill(x - 1, y) || isFill(x + 1, y) || isFill(x, y - 1) || isFill(x, y + 1)) {
            count++;
          }
        }
      }
      return count;
    },
    { fr, fg, fb, fa },
  );
}

/** A closed loop drawn freehand, which is how a person actually encloses an area. */
async function freehandLoop(page: Page) {
  await setTool(page, "pencil");
  await setWidth(page, 6);
  await pickColour(page, "#000000");
  await drawStroke(page, { x: 240, y: 180 }, { x: 400, y: 182 }, { steps: 12 });
  await drawStroke(page, { x: 400, y: 182 }, { x: 402, y: 340 }, { steps: 12 });
  await drawStroke(page, { x: 402, y: 340 }, { x: 240, y: 342 }, { steps: 12 });
  await drawStroke(page, { x: 240, y: 342 }, { x: 240, y: 180 }, { steps: 12 });
}

test("a fill reaches the wall of a freehand loop, leaving no antialiased fringe", async ({ page }) => {
  // The reported defect. A shape tool already fills flush — but a freehand stroke is
  // antialiased all the way round, so exact matching stops at the first partial-alpha pixel
  // and leaves a hairline between the fill and the line.
  await freehandLoop(page);
  await setTool(page, "fill");
  await pickColour(page, "#f72585");
  await fillAt(page, 320, 260);

  expect(await ink(page)).toBeGreaterThan(20_000);
  expect(await countAdjacentFringe(page, [247, 37, 133, 255])).toBe(0);
});

test("undo of a fill that absorbed a fringe restores the document exactly", async ({ page }) => {
  // Absorption rewrites pixels the fill itself never selected. Because a fill record stores
  // only parameters, undo re-runs the whole thing against the reconstructed artwork — so the
  // absorbed ramp has to come back identically or undo leaves residue along the whole loop.
  await freehandLoop(page);
  const before = await pixels(page);

  await setTool(page, "fill");
  await pickColour(page, "#f72585");
  await fillAt(page, 320, 260);
  const after = await pixels(page);
  expect(after).not.toBe(before);

  await page.evaluate(() => window.__paintpad.undo());
  await page.waitForTimeout(200);
  expect(await pixels(page)).toBe(before);

  await page.evaluate(() => window.__paintpad.redo());
  await page.waitForTimeout(200);
  expect(await pixels(page)).toBe(after);
});

test("a fill survives a zoom round trip", async ({ page }) => {
  await closedBox(page, "#000000");
  await setTool(page, "fill");
  await pickColour(page, "#f72585");
  await fillAt(page, 280, 200);
  const before = await pixels(page);

  for (let i = 0; i < 4; i++) await page.getByRole("button", { name: "+", exact: true }).click();
  for (let i = 0; i < 4; i++) await page.getByRole("button", { name: "−", exact: true }).click();
  await page.waitForTimeout(160);

  expect(await pixels(page)).toBe(before);
});
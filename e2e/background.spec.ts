import { expect, test, type Page } from "@playwright/test";
import { canvasLocator, clearCanvas, dragShape, drawStroke, setFill, setTool, setWidth } from "./helpers";

/**
 * Canvas background verification.
 *
 * The decisive pair is "eraser restores the background" versus "eraser always punches
 * through". Both are plausible; only one is what someone means by a background colour.
 */

const pixels = (page: Page) => page.evaluate(() => window.__paintpad.snapshotDataUrl()!);
const ink = (page: Page) => page.evaluate(() => window.__paintpad.documentInkCount());

/** Alpha histogram of the composited canvas: [opaque, translucent, transparent]. */
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

const canvasBg = (page: Page) => page.getByTestId("swatch-background");

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(canvasLocator(page)).toBeVisible();
  await page.evaluate(() => localStorage.clear());
  await clearCanvas(page);
});

test("a fresh document is transparent", async ({ page }) => {
  const [opaque, , transparent] = await alphaBuckets(page);
  expect(opaque).toBe(0);
  expect(transparent).toBeGreaterThan(0);
});

test("setting a background fills the canvas opaquely", async ({ page }) => {
  await canvasBg(page).click();
  await page.getByTestId("hex-input").fill("#1b9e77");
  await page.getByTestId("hex-input").press("Enter");
  await page.waitForTimeout(150);

  const [opaque, translucent, transparent] = await alphaBuckets(page);
  expect(transparent).toBe(0);
  expect(translucent).toBe(0);
  expect(opaque).toBeGreaterThan(1000);

  const centre = await page.evaluate(() => {
    const canvas = document.querySelector("canvas.surface") as HTMLCanvasElement;
    const ctx = canvas.getContext("2d")!;
    return Array.from(ctx.getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data);
  });
  expect(centre).toEqual([0x1b, 0x9e, 0x77, 255]);
});

test("clearing the background returns the canvas to transparency", async ({ page }) => {
  await canvasBg(page).click();
  await page.getByTestId("hex-input").fill("#3a0ca3");
  await page.getByTestId("hex-input").press("Enter");
  await page.waitForTimeout(120);

  await page.getByTestId("background-none").click();
  await page.waitForTimeout(150);

  const [opaque, , transparent] = await alphaBuckets(page);
  expect(opaque).toBe(0);
  expect(transparent).toBeGreaterThan(0);
});

test("HEADLINE: erasing with a background set restores that colour", async ({ page }) => {
  await setWidth(page, 22);
  await pickForeground(page, "#000000");
  await drawStroke(page, { x: 60, y: 200 }, { x: 500, y: 200 }, { steps: 22 });

  await canvasBg(page).click();
  await page.getByTestId("hex-input").fill("#1b9e77");
  await page.getByTestId("hex-input").press("Enter");
  await page.waitForTimeout(150);

  await setTool(page, "eraser");
  await drawStroke(page, { x: 230, y: 80 }, { x: 230, y: 340 }, { steps: 18 });
  await page.waitForTimeout(120);

  // The erased band must match the background exactly: opaque, and the right colour.
  const counts = await page.evaluate(() => {
    const canvas = document.querySelector("canvas.surface") as HTMLCanvasElement;
    const ctx = canvas.getContext("2d")!;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const near = (a: number, b: number) => Math.abs(a - b) < 45;
    let backgroundColour = 0;
    let transparent = 0;
    let dark = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 0) transparent++;
      else if (near(data[i]!, 0x1b) && near(data[i + 1]!, 0x9e) && near(data[i + 2]!, 0x77)) backgroundColour++;
      else if (data[i]! < 90) dark++;
    }
    return { backgroundColour, transparent, dark };
  });

  // The gap is the background colour — NOT transparent, and NOT checkerboard.
  expect(counts.backgroundColour).toBeGreaterThan(1000);
  expect(counts.transparent).toBe(0);
  // The surviving stroke is still there.
  expect(counts.dark).toBeGreaterThan(1000);
});

test("erasing with NO background still erases to transparency", async ({ page }) => {
  await setWidth(page, 22);
  await pickForeground(page, "#000000");
  await drawStroke(page, { x: 60, y: 200 }, { x: 500, y: 200 }, { steps: 22 });

  await setTool(page, "eraser");
  await drawStroke(page, { x: 230, y: 80 }, { x: 230, y: 340 }, { steps: 18 });
  await page.waitForTimeout(120);

  const [opaque, , transparent] = await alphaBuckets(page);
  expect(transparent).toBeGreaterThan(1000);
  expect(opaque).toBeGreaterThan(1000); // the surviving stroke
});

test("existing art survives a background change", async ({ page }) => {
  await setWidth(page, 20);
  await pickForeground(page, "#c00000");
  await drawStroke(page, { x: 80, y: 80 }, { x: 380, y: 280 }, { steps: 18 });
  const withTransparent = await pixels(page);

  await canvasBg(page).click();
  await page.getByTestId("hex-input").fill("#ffe66d");
  await page.getByTestId("hex-input").press("Enter");
  await page.waitForTimeout(150);

  // The art is unchanged; only the backdrop moved.
  const before = await pixels(page);
  expect(before).not.toBe(withTransparent);

  await canvasBg(page).click();
  await page.getByTestId("background-none").click();
  await page.waitForTimeout(150);
  expect(await pixels(page)).toBe(withTransparent);
});

test("the background is not an undoable operation", async ({ page }) => {
  await setWidth(page, 20);
  await pickForeground(page, "#000000");
  await drawStroke(page, { x: 80, y: 80 }, { x: 380, y: 280 }, { steps: 18 });

  await canvasBg(page).click();
  await page.getByTestId("hex-input").fill("#1b9e77");
  await page.getByTestId("hex-input").press("Enter");
  await page.waitForTimeout(150);

  await page.evaluate(() => window.__paintpad.undo());
  await page.waitForTimeout(140);

  // The stroke is gone but the background is a document setting, not a mark.
  const [opaque] = await alphaBuckets(page);
  expect(opaque).toBeGreaterThan(1000);

  const centre = await page.evaluate(() => {
    const canvas = document.querySelector("canvas.surface") as HTMLCanvasElement;
    const ctx = canvas.getContext("2d")!;
    return Array.from(ctx.getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data);
  });
  expect(centre).toEqual([0x1b, 0x9e, 0x77, 255]);
});

test("undo of an erase still works with a background set", async ({ page }) => {
  await setWidth(page, 22);
  await pickForeground(page, "#000000");
  await drawStroke(page, { x: 60, y: 200 }, { x: 500, y: 200 }, { steps: 22 });

  await canvasBg(page).click();
  await page.getByTestId("hex-input").fill("#1b9e77");
  await page.getByTestId("hex-input").press("Enter");
  await page.waitForTimeout(150);

  await setTool(page, "eraser");
  await drawStroke(page, { x: 230, y: 80 }, { x: 230, y: 340 }, { steps: 18 });
  const erased = await pixels(page);

  await page.evaluate(() => window.__paintpad.undo());
  await page.waitForTimeout(140);
  const restored = await pixels(page);
  expect(restored).not.toBe(erased);

  await page.evaluate(() => window.__paintpad.redo());
  await page.waitForTimeout(140);
  expect(await pixels(page)).toBe(erased);
});

test("documentInkCount is correct in both background modes", async ({ page }) => {
  expect(await ink(page)).toBe(0);

  await setWidth(page, 20);
  await pickForeground(page, "#000000");
  await drawStroke(page, { x: 80, y: 80 }, { x: 380, y: 280 }, { steps: 18 });
  const inkOnTransparent = await ink(page);
  expect(inkOnTransparent).toBeGreaterThan(500);

  // With a solid background, "ink" must mean "differs from the background" — not "opaque",
  // which would be the entire canvas.
  await canvasBg(page).click();
  await page.getByTestId("hex-input").fill("#ffffff");
  await page.getByTestId("hex-input").press("Enter");
  await page.waitForTimeout(150);

  expect(await ink(page)).toBe(inkOnTransparent);

  await page.getByTestId("background-none").click();
  await page.waitForTimeout(150);
  expect(await ink(page)).toBe(inkOnTransparent);
});

test("swap is inert with no background and exchanges colours when one is set", async ({ page }) => {
  await pickForeground(page, "#ff0000");
  const swap = page.locator("button.swap");

  // No background: swapping a colour with "nothing" is meaningless.
  await expect(swap).toBeDisabled();

  await canvasBg(page).click();
  await page.getByTestId("hex-input").fill("#0000ff");
  await page.getByTestId("hex-input").press("Enter");
  await page.waitForTimeout(150);
  await expect(swap).toBeEnabled();

  const before = await colours(page);
  await swap.click();
  const after = await colours(page);
  expect(after.foreground).toBe(before.background);
  expect(after.background).toBe(before.foreground);
});

test("the background survives a zoom round trip", async ({ page }) => {
  await canvasBg(page).click();
  await page.getByTestId("hex-input").fill("#4361ee");
  await page.getByTestId("hex-input").press("Enter");
  await page.waitForTimeout(150);
  const before = await pixels(page);

  for (let i = 0; i < 4; i++) await page.getByRole("button", { name: "+", exact: true }).click();
  for (let i = 0; i < 4; i++) await page.getByRole("button", { name: "−", exact: true }).click();
  await page.waitForTimeout(140);

  expect(await pixels(page)).toBe(before);
});

test("shapes still use the foreground colour over a background", async ({ page }) => {
  await canvasBg(page).click();
  await page.getByTestId("hex-input").fill("#ffffff");
  await page.getByTestId("hex-input").press("Enter");
  await page.waitForTimeout(120);

  await setTool(page, "rect");
  await pickForeground(page, "#f72585");
  await setFill(page, true);
  await dragShape(page, { x: 80, y: 70 }, { x: 380, y: 280 });

  const record = (await page.evaluate(() => window.__paintpad.historyEntries()))[0]!;
  if (record.kind !== "shape") throw new Error("expected a shape record");
  expect(record.strokeColor).toBe("#f72585");
  expect(record.fillColor).toBe("#f72585");
});

async function pickForeground(page: Page, colour: string): Promise<void> {
  await page.getByTestId("swatch-foreground").click();
  await page.locator(`button[data-colour="${colour}"]`).click();
}

async function colours(page: Page): Promise<{ foreground: string; background: string | null }> {
  return page.evaluate(() => {
    const s = window.__paintpad.settings();
    return { foreground: s.foreground, background: s.background };
  });
}
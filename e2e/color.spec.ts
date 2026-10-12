import { expect, test, type Page } from "@playwright/test";
import { canvasLocator, clearCanvas, dragShape, drawStroke, setTool, setWidth } from "./helpers";

/**
 * Colour verification.
 *
 * The headline test is `colour is baked into records`: changing the palette after drawing
 * must not retroactively recolour what is already in history. If records ever captured a
 * palette index instead of a resolved hex, undo/redo would silently repaint old work.
 */

const ink = (page: Page) => page.evaluate(() => window.__paintpad.documentInkCount());
const colours = (page: Page) =>
  page.evaluate(() => {
    const s = window.__paintpad.settings();
    return { foreground: s.foreground, background: s.background };
  });

async function pickPalette(page: Page, colour: string): Promise<void> {
  await page.locator(`button[data-colour="${colour}"]`).click();
}

async function setHex(page: Page, value: string): Promise<void> {
  const input = page.getByTestId("hex-input");
  await input.fill(value);
  await input.press("Enter");
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(canvasLocator(page)).toBeVisible();
  await page.evaluate(() => localStorage.clear());
  await clearCanvas(page);
});

test("picking a palette colour changes the next stroke", async ({ page }) => {
  await setWidth(page, 10);
  await pickPalette(page, "#ff0000");
  expect((await colours(page)).foreground).toBe("#ff0000");

  await drawStroke(page, { x: 60, y: 60 }, { x: 360, y: 260 }, { steps: 20 });
  expect(await ink(page)).toBeGreaterThan(500);
});

test("HEADLINE: colour is baked into records, not read at replay time", async ({ page }) => {
  await setWidth(page, 10);
  await pickPalette(page, "#ff0000");
  await drawStroke(page, { x: 60, y: 60 }, { x: 360, y: 260 }, { steps: 20 });

  const redOnly = await page.evaluate(() => {
    const canvas = document.querySelector("canvas.surface") as HTMLCanvasElement;
    return canvas.toDataURL("image/png");
  });

  // Change the palette, then round-trip through undo/redo.
  await pickPalette(page, "#4361ee");
  expect((await colours(page)).foreground).toBe("#4361ee");

  await page.evaluate(() => window.__paintpad.undo());
  await page.waitForTimeout(80);
  await page.evaluate(() => window.__paintpad.redo());
  await page.waitForTimeout(80);

  const afterRoundTrip = await page.evaluate(() => {
    const canvas = document.querySelector("canvas.surface") as HTMLCanvasElement;
    return canvas.toDataURL("image/png");
  });

  // Still red — the record carries the resolved colour, so nothing drifted.
  expect(afterRoundTrip).toBe(redOnly);
});

test("a custom hex value applies", async ({ page }) => {
  await setHex(page, "1B9E77");
  expect((await colours(page)).foreground).toBe("#1b9e77");

  await setWidth(page, 10);
  await drawStroke(page, { x: 60, y: 60 }, { x: 340, y: 240 }, { steps: 18 });
  expect(await ink(page)).toBeGreaterThan(500);
});

test("a three-digit hex is expanded", async ({ page }) => {
  await setHex(page, "#f0a");
  expect((await colours(page)).foreground).toBe("#ff00aa");
});

test("invalid hex is rejected and leaves the colour untouched", async ({ page }) => {
  await pickPalette(page, "#c00000");
  const before = await colours(page);

  for (const bad of ["nope", "#12345", "#gggggg", "#ff000080"]) {
    await setHex(page, bad);
    expect((await colours(page)).foreground).toBe(before.foreground);
    await expect(page.getByTestId("hex-input")).toHaveAttribute("aria-invalid", "true");
  }
});

test("swap exchanges primary and secondary", async ({ page }) => {
  await pickPalette(page, "#ff0000");
  await page.getByTestId("swatch-background").click();
  await setHex(page, "#0000ff");
  expect(await colours(page)).toEqual({ foreground: "#ff0000", background: "#0000ff" });

  await page.locator("button.swap").click();
  expect(await colours(page)).toEqual({ foreground: "#0000ff", background: "#ff0000" });
});

test("X swaps colours", async ({ page }) => {
  await pickPalette(page, "#ff0000");
  await page.getByTestId("swatch-background").click();
  await setHex(page, "#00ff00");

  // Committing a hex releases focus, so the shortcut is live again immediately.
  await page.keyboard.press("x");
  expect(await colours(page)).toEqual({ foreground: "#00ff00", background: "#ff0000" });
});

test("shortcuts stay inert while typing a hex value", async ({ page }) => {
  // A text field owns its own keyboard: `x` must be typed, not treated as a swap.
  await pickPalette(page, "#ff0000");
  await page.getByTestId("swatch-background").click();

  const input = page.getByTestId("hex-input");
  await input.click();
  await input.fill("");
  await input.pressSequentially("abcdef", { delay: 10 });

  expect(await input.inputValue()).toBe("abcdef");
  // The canvas background defaults to transparent, not to a colour.
  expect(await colours(page)).toEqual({ foreground: "#ff0000", background: null });
});

test("picking a palette colour for the background slot sets the canvas background", async ({ page }) => {
  // Palette, hex, and native picker all write to whichever slot is active.
  await pickPalette(page, "#ffd166");
  await page.getByTestId("swatch-background").click();
  await pickPalette(page, "#11845b");
  expect(await colours(page)).toEqual({ foreground: "#ffd166", background: "#11845b" });

  // Switching slots back leaves the background alone.
  await page.getByTestId("swatch-foreground").click();
  await pickPalette(page, "#f72585");
  expect(await colours(page)).toEqual({ foreground: "#f72585", background: "#11845b" });
});

test("invalid hex leaves the canvas background untouched", async ({ page }) => {
  await page.getByTestId("swatch-background").click();
  await pickPalette(page, "#11845b");

  await setHex(page, "not-a-colour");
  expect((await colours(page)).background).toBe("#11845b");
  await expect(page.getByTestId("hex-input")).toHaveAttribute("aria-invalid", "true");
});

test("the eraser restores the canvas background it was drawn over", async ({ page }) => {
  // Colour 2 is now the canvas background, so the eraser restores it. With no background
  // set, erasing still goes to true transparency — covered in background.spec.ts.
  await setWidth(page, 10);
  await pickPalette(page, "#000000");
  await drawStroke(page, { x: 60, y: 150 }, { x: 380, y: 150 }, { steps: 20 });

  await page.getByTestId("swatch-background").click();
  await setHex(page, "#1b9e77");

  await setTool(page, "eraser");
  await drawStroke(page, { x: 150, y: 90 }, { x: 150, y: 220 }, { steps: 14 });

  const counts = await page.evaluate(() => {
    const canvas = document.querySelector("canvas.surface") as HTMLCanvasElement;
    const ctx = canvas.getContext("2d")!;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const near = (a: number, b: number) => Math.abs(a - b) < 45;
    let background = 0;
    let transparent = 0;
    let dark = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 0) transparent++;
      else if (near(data[i]!, 0x1b) && near(data[i + 1]!, 0x9e) && near(data[i + 2]!, 0x77)) background++;
      else if (data[i]! < 90) dark++;
    }
    return { background, transparent, dark };
  });

  expect(counts.background).toBeGreaterThan(1000);
  expect(counts.transparent).toBe(0);
  expect(counts.dark).toBeGreaterThan(1000);
});

test("Clear leaves a blank canvas showing the background colour", async ({ page }) => {
  // Clear means "blank canvas", and a blank canvas with a background set IS that colour —
  // the same way Paint's white canvas survives Clear.
  await setWidth(page, 12);
  await pickPalette(page, "#000000");
  await drawStroke(page, { x: 60, y: 60 }, { x: 360, y: 260 }, { steps: 18 });
  expect(await ink(page)).toBeGreaterThan(0);

  await page.getByTestId("swatch-background").click();
  await setHex(page, "#3a0ca3");
  await page.getByRole("button", { name: "Clear" }).click();
  await page.waitForTimeout(120);

  // No ink, because ink means "differs from the background".
  expect(await ink(page)).toBe(0);

  const centre = await page.evaluate(() => {
    const canvas = document.querySelector("canvas.surface") as HTMLCanvasElement;
    const ctx = canvas.getContext("2d")!;
    const [r, g, b, a] = ctx.getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data;
    return { r, g, b, a };
  });
  expect(centre).toEqual({ r: 0x3a, g: 0x0c, b: 0xa3, a: 255 });
});

test("drawing and undoing work on a dark background", async ({ page }) => {
  await page.getByTestId("swatch-background").click();
  await setHex(page, "#181825");
  await page.getByRole("button", { name: "Clear" }).click();
  await page.waitForTimeout(80);

  await setWidth(page, 10);
  await pickPalette(page, "#ffe66d");
  await drawStroke(page, { x: 60, y: 60 }, { x: 360, y: 260 }, { steps: 18 });
  expect(await ink(page)).toBeGreaterThan(500);

  await page.evaluate(() => window.__paintpad.undo());
  await page.waitForTimeout(100);
  expect(await ink(page)).toBe(0);
});

test("recent colours accumulate and are remembered", async ({ page }) => {
  await pickPalette(page, "#ff0000");
  await setHex(page, "#00ff00");
  await expect(page.locator("[data-recent]")).toHaveCount(2);

  const stored = await page.evaluate(() => localStorage.getItem("paintpad.recents"));
  expect(stored).toContain("#ff0000");
  expect(stored).toContain("#00ff00");
});

test("shapes use the foreground colour", async ({ page }) => {
  await pickPalette(page, "#f72585");
  await setTool(page, "rect");
  await dragShape(page, { x: 80, y: 70 }, { x: 380, y: 280 });

  const record = (await page.evaluate(() => window.__paintpad.historyEntries()))[0]!;
  if (record.kind !== "shape") throw new Error("expected a shape record");
  expect(record.strokeColor).toBe("#f72585");
});
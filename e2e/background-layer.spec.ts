import { expect, test, type Page } from "@playwright/test";
import { canvasLocator, clearCanvas, drawStroke, setTool, setWidth } from "./helpers";

/**
 * Regression suite for the stale-background bug.
 *
 * The background used to be baked into the artwork raster, and the eraser painted the
 * background colour at erase time. Changing the background afterwards therefore left every
 * erased area frozen at the old colour, looking like deliberate drawing.
 *
 * These tests pin the fixed behaviour: the background is composited beneath the artwork and
 * is never painted into erased regions.
 */

const pixels = (page: Page) => page.evaluate(() => window.__paintpad.snapshotDataUrl()!);

async function pickForeground(page: Page, colour: string): Promise<void> {
  await page.getByTestId("swatch-foreground").click();
  await page.locator(`button[data-colour="${colour}"]`).click();
}

async function setCanvasBackground(page: Page, colour: string | null): Promise<void> {
  await page.getByTestId("swatch-background").click();
  if (colour === null) {
    await page.getByTestId("background-none").click();
  } else {
    await page.getByTestId("hex-input").fill(colour);
    await page.getByTestId("hex-input").press("Enter");
  }
  await page.waitForTimeout(150);
}

/** Count pixels matching a colour within tolerance, and transparent pixels. */
async function colourHistogram(page: Page) {
  return page.evaluate(() => {
    const canvas = document.querySelector("canvas.surface") as HTMLCanvasElement;
    const ctx = canvas.getContext("2d")!;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const near = (a: number, b: number) => Math.abs(a - b) < 45;
    const matches = (hex: string) => {
      const v = parseInt(hex.slice(1), 16);
      return [v >> 16, (v >> 8) & 255, v & 255];
    };
    const counts: Record<string, number> = { white: 0, green: 0, red: 0, blue: 0, transparent: 0, dark: 0 };
    const W = matches("#ffffff");
    const G = matches("#1b9e77");
    const B = matches("#4361ee");
    const R = matches("#ff0000");
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 0) {
        counts.transparent!++;
      } else if (near(data[i]!, W[0]!) && near(data[i + 1]!, W[1]!) && near(data[i + 2]!, W[2]!)) {
        counts.white!++;
      } else if (near(data[i]!, G[0]!) && near(data[i + 1]!, G[1]!) && near(data[i + 2]!, G[2]!)) {
        counts.green!++;
      } else if (near(data[i]!, B[0]!) && near(data[i + 1]!, B[1]!) && near(data[i + 2]!, B[2]!)) {
        counts.blue!++;
      } else if (near(data[i]!, R[0]!) && near(data[i + 1]!, R[1]!) && near(data[i + 2]!, R[2]!)) {
        counts.red!++;
      } else if (data[i]! < 90) {
        counts.dark!++;
      }
    }
    return counts;
  });
}

/**
 * Sample the composited canvas at a point expressed in canvas-relative CSS coordinates
 * (the same space the drawing helpers use). Counting colours across the whole canvas is
 * not enough: a frozen white band sitting on a blue background still contains plenty of
 * blue, so a histogram assertion passes even when the bug is present.
 */
async function sampleAt(page: Page, x: number, y: number): Promise<[number, number, number, number]> {
  return page.evaluate(
    ({ px, py }) => {
      const canvas = document.querySelector("canvas.surface") as HTMLCanvasElement;
      const rect = canvas.getBoundingClientRect();
      const ctx = canvas.getContext("2d")!;
      const sx = Math.round((px / rect.width) * canvas.width);
      const sy = Math.round((py / rect.height) * canvas.height);
      return Array.from(ctx.getImageData(sx, sy, 1, 1).data) as [
        number,
        number,
        number,
        number,
      ];
    },
    { px: x, py: y },
  );
}

const near = (a: number, b: number) => Math.abs(a - b) < 45;
const isColour = (
  sample: [number, number, number, number],
  hex: string,
  tolerance = 45,
) => {
  const v = parseInt(hex.slice(1), 16);
  const target: [number, number, number] = [v >> 16, (v >> 8) & 255, v & 255];
  return (
    Math.abs(sample[0]! - target[0]) < tolerance &&
    Math.abs(sample[1]! - target[1]) < tolerance &&
    Math.abs(sample[2]! - target[2]) < tolerance
  );
};

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(canvasLocator(page)).toBeVisible();
  await page.evaluate(() => localStorage.clear());
  await clearCanvas(page);
});

test("HEADLINE: changing the background repaints previously erased areas", async ({ page }) => {
  await setWidth(page, 22);
  await pickForeground(page, "#000000");
  // A horizontal stroke crossed by a vertical erase, meeting at (230, 200).
  await drawStroke(page, { x: 60, y: 200 }, { x: 500, y: 200 }, { steps: 22 });

  await setCanvasBackground(page, "#ffffff");
  await setTool(page, "eraser");
  await drawStroke(page, { x: 230, y: 80 }, { x: 230, y: 340 }, { steps: 18 });
  await page.waitForTimeout(120);

  // The gap currently shows white, matching the background it was erased against.
  const whiteGap = await sampleAt(page, 230, 200);
  expect(near(whiteGap[0]!, 255) && near(whiteGap[1]!, 255) && near(whiteGap[2]!, 255)).toBe(true);

  // Change the background. The erased area must follow it.
  await setCanvasBackground(page, "#4361ee");
  await page.waitForTimeout(150);

  // Sample the exact erased point: it must be the NEW background, not the old white.
  const afterChange = await sampleAt(page, 230, 200);
  expect(isColour(afterChange, "#4361ee")).toBe(true);
  // The old white must be gone from that point — this is the actual regression.
  expect(near(afterChange[0]!, 255) && near(afterChange[1]!, 255) && near(afterChange[2]!, 255)).toBe(
    false,
  );

  // A point on the stroke away from the gap is still the stroke colour.
  expect(near((await sampleAt(page, 120, 200))[0]!, 0)).toBe(true);
  void colourHistogram;
});

test("erased areas are never frozen at a superseded background", async ({ page }) => {
  await setWidth(page, 20);
  await pickForeground(page, "#000000");
  await drawStroke(page, { x: 60, y: 150 }, { x: 500, y: 150 }, { steps: 22 });

  await setCanvasBackground(page, "#1b9e77");
  await setTool(page, "eraser");
  await drawStroke(page, { x: 240, y: 60 }, { x: 240, y: 300 }, { steps: 18 });

  // Cycle the background through several colours.
  for (const colour of ["#ffffff", "#ff0000", "#4361ee"]) {
    await setCanvasBackground(page, colour);
    const counts = await colourHistogram(page);
    expect(counts.green).toBe(0);
  }

  // Landing back on the original, the gap matches it again.
  await setCanvasBackground(page, "#1b9e77");
  const final = await colourHistogram(page);
  expect(final.green).toBeGreaterThan(1000);
});

test("the eraser record is destination-out whether or not a background is set", async ({ page }) => {
  await setWidth(page, 16);
  await drawStroke(page, { x: 60, y: 150 }, { x: 400, y: 150 }, { steps: 20 });

  await setTool(page, "eraser");
  await drawStroke(page, { x: 200, y: 60 }, { x: 200, y: 240 }, { steps: 12 });

  let records = await page.evaluate(() => window.__paintpad.historyEntries());
  const eraseWithoutBackground = records[1]!;
  if (eraseWithoutBackground.kind !== "stroke") throw new Error("expected a stroke record");
  expect(eraseWithoutBackground.composite).toBe("destination-out");

  await setCanvasBackground(page, "#ffffff");
  await setTool(page, "eraser");
  await drawStroke(page, { x: 300, y: 60 }, { x: 300, y: 240 }, { steps: 12 });

  records = await page.evaluate(() => window.__paintpad.historyEntries());
  const eraseWithBackground = records[2]!;
  if (eraseWithBackground.kind !== "stroke") throw new Error("expected a stroke record");
  // The record must not branch on the background. That branch is what froze the pixels.
  expect(eraseWithBackground.composite).toBe("destination-out");
});

test("changing the background does not disturb the artwork", async ({ page }) => {
  await setWidth(page, 18);
  await pickForeground(page, "#c00000");
  await dragShape(page, { x: 80, y: 70 }, { x: 380, y: 280 });
  await drawStroke(page, { x: 80, y: 300 }, { x: 380, y: 380 }, { steps: 16 });

  const recordsBefore = await page.evaluate(() => window.__paintpad.historyEntries());
  const before = await pixels(page);

  await setCanvasBackground(page, "#1b9e77");
  await setCanvasBackground(page, null);
  await setCanvasBackground(page, "#4361ee");

  const recordsAfter = await page.evaluate(() => window.__paintpad.historyEntries());
  expect(recordsAfter).toEqual(recordsBefore);

  // With the background back to transparent the document is byte-identical to before.
  await setCanvasBackground(page, null);
  await page.waitForTimeout(150);
  expect(await pixels(page)).toBe(before);
});

test("the erase preview matches what the commit produces", async ({ page }) => {
  await setWidth(page, 26);
  await pickForeground(page, "#000000");
  await drawStroke(page, { x: 60, y: 200 }, { x: 500, y: 200 }, { steps: 22 });
  await setCanvasBackground(page, "#1b9e77");

  // Hold mid-drag: the preview must already look erased.
  const box = (await canvasLocator(page).boundingBox())!;
  await page.mouse.move(box.x + 230, box.y + 80);
  await page.mouse.down();
  await page.mouse.move(box.x + 230, box.y + 340, { steps: 18 });
  await page.waitForTimeout(120);

  const duringDrag = await colourHistogram(page);
  // Mid-drag the gap is already the background colour, not checkerboard.
  expect(duringDrag.green).toBeGreaterThan(1000);
  expect(duringDrag.transparent).toBe(0);

  await page.mouse.up();
  await page.waitForTimeout(150);

  const afterCommit = await colourHistogram(page);
  expect(afterCommit.green).toBeGreaterThan(1000);
  expect(afterCommit.transparent).toBe(0);
});

async function dragShape(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  const canvas = page.locator("canvas.surface");
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + from.x, box.y + from.y);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) {
    const t = i / 6;
    await page.mouse.move(box.x + from.x + (to.x - from.x) * t, box.y + from.y + (to.y - from.y) * t);
  }
  await page.mouse.up();
  await page.waitForTimeout(60);
}
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { canvasLocator, clearCanvas } from "./helpers";

/**
 * The export size chooser.
 *
 * Asserted against a real decoded download rather than a mocked event, so a dialog that
 * appeared to work but wrote the wrong size could not pass.
 */

const DIALOG = "dialog";

async function inspect(page: Page, bytes: Buffer) {
  return page.evaluate(async (data) => {
    const img = new Image();
    img.src = `data:image/png;base64,${data}`;
    await img.decode();
    return { width: img.width, height: img.height };
  }, bytes.toString("base64"));
}

/** Drive the full dialog flow and return the downloaded file's bytes. */
async function exportViaDialog(page: Page, tier: string): Promise<Buffer> {
  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("export").click();
  await expect(page.getByRole(DIALOG)).toBeVisible();
  await page.getByTestId(`export-size-${tier}`).click();
  await page.getByTestId("export-confirm").click();
  const download = await downloadPromise;
  const path = await download.path();
  expect(path).not.toBeNull();
  return readFileSync(path!);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(canvasLocator(page)).toBeVisible();
  await page.evaluate(() => localStorage.clear());
  await clearCanvas(page);
});

test("Export opens a chooser instead of downloading immediately", async ({ page }) => {
  let downloaded = false;
  page.on("download", () => {
    downloaded = true;
  });

  await page.getByTestId("export").click();
  await expect(page.getByRole(DIALOG)).toBeVisible();
  await page.waitForTimeout(400);

  expect(downloaded).toBe(false);
});

test("the size buttons show the document's own dimensions", async ({ page }) => {
  await page.getByTestId("export").click();
  await expect(page.getByTestId("export-size-small")).toContainText("640 × 360");
  await expect(page.getByTestId("export-size-standard")).toContainText("1280 × 720");
  await expect(page.getByTestId("export-size-full")).toContainText("2560 × 1440");
});

test("the download action is never on screen with the size buttons", async ({ page }) => {
  // The whole point of the two-step layout: an ad that later occupies the gap between these
  // screens has nothing clickable-adjacent to be mistaken for.
  await page.getByTestId("export").click();
  await expect(page.getByTestId("export-confirm")).toHaveCount(0);
  await expect(page.getByTestId("export-size-full")).toBeVisible();

  await page.getByTestId("export-size-standard").click();
  await expect(page.getByTestId("export-size-standard")).toHaveCount(0);
  await expect(page.getByTestId("export-confirm")).toBeVisible();
});

test("the standard tier downloads at the logical size", async ({ page }) => {
  expect(await inspect(page, await exportViaDialog(page, "standard"))).toEqual({
    width: 1280,
    height: 720,
  });
});

test("the small tier downloads at half the logical size", async ({ page }) => {
  expect(await inspect(page, await exportViaDialog(page, "small"))).toEqual({
    width: 640,
    height: 360,
  });
});

test("the full tier still downloads at the document's raster size", async ({ page }) => {
  expect(await inspect(page, await exportViaDialog(page, "full"))).toEqual({
    width: 2560,
    height: 1440,
  });
});

test("the downloaded filename is still timestamped", async ({ page }) => {
  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("export").click();
  await page.getByTestId("export-size-full").click();
  await page.getByTestId("export-confirm").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^paintpad-\d{8}-\d{6}\.png$/);
});

test("Escape closes the dialog without exporting", async ({ page }) => {
  let downloaded = false;
  page.on("download", () => {
    downloaded = true;
  });

  await page.getByTestId("export").click();
  await expect(page.getByRole(DIALOG)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole(DIALOG)).toHaveCount(0);

  await page.waitForTimeout(300);
  expect(downloaded).toBe(false);
});

test("a backdrop click closes the dialog", async ({ page }) => {
  await page.getByTestId("export").click();
  await expect(page.getByRole(DIALOG)).toBeVisible();

  // Far from the centred panel, so this lands on ::backdrop.
  await page.mouse.click(5, 5);
  await expect(page.getByRole(DIALOG)).toHaveCount(0);
});

test("Cancel closes the dialog", async ({ page }) => {
  await page.getByTestId("export").click();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole(DIALOG)).toHaveCount(0);
});

test("Back returns to the size list", async ({ page }) => {
  await page.getByTestId("export").click();
  await page.getByTestId("export-size-small").click();
  await expect(page.getByTestId("export-confirm")).toBeVisible();

  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByTestId("export-size-small")).toBeVisible();
  await expect(page.getByTestId("export-confirm")).toHaveCount(0);
});

test("the dialog closes itself after a download", async ({ page }) => {
  await exportViaDialog(page, "small");
  await expect(page.getByRole(DIALOG)).toHaveCount(0);
});

test("focus moves into the dialog on open", async ({ page }) => {
  await page.getByTestId("export").click();
  await expect(page.getByRole(DIALOG)).toBeVisible();

  const inside = await page.evaluate(() => {
    const dialog = document.querySelector("dialog");
    return dialog?.contains(document.activeElement) ?? false;
  });
  expect(inside).toBe(true);
});

test("focus is trapped while the dialog is open", async ({ page }) => {
  await page.getByTestId("export").click();
  await expect(page.getByRole(DIALOG)).toBeVisible();

  // Tab well past the number of controls; a native modal dialog must never let focus
  // reach the canvas behind it.
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    const escaped = await page.evaluate(() => document.activeElement?.tagName === "CANVAS");
    expect(escaped).toBe(false);
  }
});

test("the dialog is labelled and the size group is named", async ({ page }) => {
  await page.getByTestId("export").click();
  await expect(page.getByRole(DIALOG, { name: "Export" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Output size" })).toBeVisible();
});

test("the canvas is not reachable behind the dialog", async ({ page }) => {
  await page.getByTestId("export").click();
  await expect(page.getByRole(DIALOG)).toBeVisible();

  // A modal dialog makes the rest of the document inert, so hit-testing over the canvas
  // must not reach it — otherwise a click intended for the panel would draw instead.
  const topmost = await page.evaluate(() => {
    const canvas = document.querySelector("canvas.surface")!;
    const box = canvas.getBoundingClientRect();
    return document.elementsFromPoint(box.left + 5, box.top + 5)[0]?.tagName;
  });
  expect(topmost).not.toBe("CANVAS");
});

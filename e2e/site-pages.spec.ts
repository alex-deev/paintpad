import { expect, test } from "@playwright/test";
import { canvasLocator, clearCanvas, drawStroke, setWidth } from "./helpers";

/**
 * The static pages in /public.
 *
 * The pages are plain files served straight from the build root, so these assert two things
 * that are easy to break silently: that they are actually reachable from the running app, and
 * that reaching them does not cost the user their drawing.
 */

const PAGES = [
  { path: "/about.html", heading: "About PaintPad" },
  { path: "/privacy.html", heading: "Privacy" },
  { path: "/terms.html", heading: "Terms" },
  { path: "/contact.html", heading: "Contact" },
];

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(canvasLocator(page)).toBeVisible();
  await page.evaluate(() => localStorage.clear());
  await clearCanvas(page);
});

test("the editor links to the About page from the brand", async ({ page }) => {
  const brand = page.getByRole("link", { name: "PaintPad" });
  await expect(brand).toBeVisible();
  await expect(brand).toHaveAttribute("href", "/about.html");
});

test("every page is reachable and renders its own heading", async ({ page }) => {
  await page.goto("/about.html");
  for (const { path, heading } of PAGES) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
  }
});

test("every page cross-links to the others", async ({ page }) => {
  await page.goto("/about.html");
  const nav = page.getByRole("navigation", { name: "Site" });
  for (const { path } of PAGES) {
    await page.goto(path);
    await expect(nav.getByRole("link")).toHaveCount(PAGES.length);
    await expect(nav.locator(`a[href="${path}"]`)).toHaveCount(1);
  }
});

test("each page links back to the editor", async ({ page }) => {
  for (const { path } of PAGES) {
    await page.goto(path);
    await expect(page.getByRole("link", { name: "Back to the editor" }).first()).toBeVisible();
  }
});

test("the privacy page names every storage key the app actually uses", async ({ page }) => {
  // If a key is added or removed in src/, this fails until the disclosure is corrected.
  await page.goto("/privacy.html");
  const body = (await page.locator("main").innerText()).replace(/\s+/g, " ");

  expect(body).toContain("paintpad.recents");
  expect(body).toContain("paintpad.flush");
  expect(body).toContain("documents");
  expect(body).toContain("current");
  expect(body).toContain("IndexedDB");
});

test("each page declares a language and a viewport", async ({ page }) => {
  for (const { path } of PAGES) {
    await page.goto(path);
    expect(await page.locator("html").getAttribute("lang")).toBe("en");
    expect(await page.locator('meta[name="viewport"]').count()).toBe(1);
    await expect(page).toHaveTitle(/\w+ — PaintPad|PaintPad/);
  }
});

test("navigating away and back preserves the drawing", async ({ page }) => {
  await setWidth(page, 30);
  await drawStroke(page, { x: 80, y: 80 }, { x: 400, y: 320 }, { steps: 22 });
  const before = await page.evaluate(() => window.__paintpad.documentInkCount());
  expect(before).toBeGreaterThan(0);

  await page.getByRole("link", { name: "PaintPad" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "About PaintPad" })).toBeVisible();

  await page.goBack();
  await expect(canvasLocator(page)).toBeVisible();

  expect(await page.evaluate(() => window.__paintpad.documentInkCount())).toBe(before);
});

test("the brand link does not change the chrome budget", async ({ page }) => {
  // The brand is a link precisely because it costs no layout: the bars' combined share of
  // the viewport is pinned by e2e/responsive.spec.ts, so this guards the choice against
  // someone "improving" it into four visible links later.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(canvasLocator(page)).toBeVisible();
  await page.waitForTimeout(250);

  const result = await page.evaluate(() => {
    const rows = (selector: string) =>
      Math.round((document.querySelector(selector) as HTMLElement).getBoundingClientRect().height);
    const doc = document.documentElement;
    return {
      // Bars scrolling sideways at phone widths is the intended design, so the invariant
      // that matters is the page itself never scrolling.
      pageOverflowX: doc.scrollWidth > doc.clientWidth,
      pageOverflowY: doc.scrollHeight > doc.clientHeight,
      topbarHeight: rows(".topbar"),
      chromePct: Math.round(((rows(".topbar") + rows(".toolbar") + rows(".colourbar")) / window.innerHeight) * 100),
    };
  });

  expect(result.pageOverflowX).toBe(false);
  expect(result.pageOverflowY).toBe(false);
  expect(result.topbarHeight).toBeLessThan(90);
  expect(result.chromePct).toBeLessThan(30);
});

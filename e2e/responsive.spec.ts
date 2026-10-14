import { expect, test } from "@playwright/test";
import { canvasLocator, clearCanvas } from "./helpers";

/**
 * Responsive layout guards.
 *
 * These exist because the numbers moved a great deal and nothing else would have noticed. On
 * a 390x844 phone the chrome took 42% of the viewport before the compact layout — three rows
 * per bottom bar — and the canvas got less than half the screen.
 *
 * The assertions are on proportions and overflow rather than pixel heights, because absolute
 * heights will differ across browsers and there is no single correct number. What must never
 * be true is chrome eating the canvas, or the page scrolling.
 */

const PHONE = { width: 390, height: 844 };
const PHONE_LANDSCAPE = { width: 844, height: 390 };
const TABLET = { width: 768, height: 1024 };

interface Layout {
  overflowX: boolean;
  overflowY: boolean;
  /** Share of the viewport taken by chrome. */
  chromePct: number;
  stageHeight: number;
  /** True when a bar scrolls sideways rather than wrapping onto another row. */
  barsScroll: boolean;
  barRows: number;
}

async function layout(page: import("@playwright/test").Page): Promise<Layout> {
  return page.evaluate(() => {
    const rows = (el: Element) => Math.round(el.getBoundingClientRect().height);
    const bar = document.querySelector(".topbar") as HTMLElement;
    const toolbar = document.querySelector(".toolbar") as HTMLElement;
    const colour = document.querySelector(".colourbar") as HTMLElement;
    const stage = document.querySelector(".stage") as HTMLElement;
    const doc = document.documentElement;
    const chrome = rows(bar) + rows(toolbar) + rows(colour);
    return {
      overflowX: doc.scrollWidth > doc.clientWidth,
      overflowY: doc.scrollHeight > doc.clientHeight,
      chromePct: Math.round((chrome / window.innerHeight) * 100),
      stageHeight: rows(stage),
      barsScroll: toolbar.scrollWidth > toolbar.clientWidth || colour.scrollWidth > colour.clientWidth,
      // A wrapping toolbar is far taller than a 42px touch target; one row is not.
      barRows: rows(toolbar) > 90 ? 2 : 1,
    };
  });
}

async function openAt(page: import("@playwright/test").Page, size: { width: number; height: number }) {
  await page.setViewportSize(size);
  await page.goto("/");
  await expect(canvasLocator(page)).toBeVisible();
  await clearCanvas(page);
  await page.waitForTimeout(250);
}

/**
 * Budgets are per-viewport because vertical room is not equal.
 *
 * Portrait phone and tablet both get 30%. Landscape phones get 35%: the whole viewport is 390px
 * tall, so three bars cannot sum to much less without dropping functionality, and 33% there
 * leaves a 262px canvas — usable. What matters is that none of these regress toward the 42% and
 * 47% this replaced, which would leave the canvas with the minority of the screen.
 */
const CASES: [string, { width: number; height: number }, number][] = [
  ["phone", PHONE, 30],
  ["landscape", PHONE_LANDSCAPE, 35],
  ["tablet", TABLET, 30],
];

for (const [name, size, budget] of CASES) {
  test(`chrome leaves the canvas the majority of a ${name} screen`, async ({ page }) => {
    await openAt(page, size);
    const result = await layout(page);

    // The bug this exists for: chrome was 42% on a phone, so the canvas got the minority.
    expect(result.chromePct).toBeLessThan(budget);
    expect(result.stageHeight).toBeGreaterThan(size.height / 2);

    // Nothing may scroll the page itself, in either axis.
    expect(result.overflowX).toBe(false);
    expect(result.overflowY).toBe(false);
  });

  test(`bars stay on one row on a ${name} screen`, async ({ page }) => {
    await openAt(page, size);
    const result = await layout(page);
    // Controls that do not fit scroll sideways instead of stacking and eating canvas height.
    expect(result.barRows).toBe(1);
    expect(result.barsScroll || size.width > 900).toBe(true);
  });
}

test("the layout still works on a desktop viewport", async ({ page }) => {
  await openAt(page, { width: 1280, height: 720 });
  const result = await layout(page);

  // Desktop should not scroll any bar — there is room for everything.
  expect(result.barsScroll).toBe(false);
  expect(result.chromePct).toBeLessThan(25);
});

test("touch targets stay large enough on a phone", async ({ page }) => {
  await openAt(page, PHONE);
  const smallest = await page.evaluate(() => {
    const tools = Array.from(document.querySelectorAll(".tool")) as HTMLElement[];
    const chips = Array.from(document.querySelectorAll(".chip")) as HTMLElement[];
    const box = (el: HTMLElement) => Math.min(el.getBoundingClientRect().width, el.getBoundingClientRect().height);
    return Math.min(...tools.map(box), ...chips.map(box));
  });
  // 42px for tools, 22px for colour chips — under the 44px guideline, because seven tools at
  // 44px plus badges exceeds a phone's width outright. This pins the floor so it cannot drift
  // downward unnoticed.
  expect(smallest).toBeGreaterThanOrEqual(20);
});
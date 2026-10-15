import { expect, test, type Page } from "@playwright/test";
import { canvasLocator, clearCanvas } from "./helpers";

/**
 * Export funnel events.
 *
 * Observed through the real dialog, because what matters is that the four outcomes stay
 * distinguishable: opened, selected, completed and cancelled have to be separable numbers. A
 * funnel where "cancelled" and "completed" collapse into one event is worse than none, because
 * it looks like a working measurement and is not.
 */

type Event = { name: string; tier?: string; width?: number; height?: number };

/** Install a recording sink, the way a real provider would be installed at startup. */
async function recordEvents(page: Page): Promise<void> {
  await page.evaluate(() => {
    const seen: Event[] = [];
    (window as unknown as { __seen: Event[] }).__seen = seen;
    window.__setAnalyticsSink((event) => {
      seen.push(event as Event);
    });
  });
}

async function events(page: Page): Promise<Event[]> {
  return page.evaluate(() => (window as unknown as { __seen: Event[] }).__seen);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(canvasLocator(page)).toBeVisible();
  await page.evaluate(() => localStorage.clear());
  await clearCanvas(page);
  await recordEvents(page);
});

test("opening the dialog reports exactly one opened event", async ({ page }) => {
  await page.getByTestId("export").click();
  await expect(page.getByRole("dialog")).toBeVisible();

  expect(await events(page)).toEqual([{ name: "export_modal_opened" }]);
});

test("a completed export reports opened, selected with dimensions, then completed", async ({ page }) => {
  const downloadPromise = page.waitForEvent("download");

  await page.getByTestId("export").click();
  await page.getByTestId("export-size-standard").click();
  await page.getByTestId("export-confirm").click();
  await downloadPromise;
  await expect(page.getByRole("dialog")).toHaveCount(0);

  expect(await events(page)).toEqual([
    { name: "export_modal_opened" },
    { name: "export_tier_selected", tier: "standard", width: 1280, height: 720 },
    { name: "export_completed", tier: "standard" },
  ]);
});

test("cancelling reports a cancel and never a completion", async ({ page }) => {
  await page.getByTestId("export").click();
  await page.getByTestId("export-size-full").click();
  await page.getByRole("button", { name: "Cancel" }).click();

  expect(await events(page)).toEqual([
    { name: "export_modal_opened" },
    { name: "export_tier_selected", tier: "full", width: 2560, height: 1440 },
    { name: "export_cancelled" },
  ]);
});

test("Escape reports a cancel exactly once", async ({ page }) => {
  await page.getByTestId("export").click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  const reported = (await events(page)).filter((e) => e.name === "export_cancelled");
  expect(reported).toHaveLength(1);
});

test("going back and choosing again reports both selections", async ({ page }) => {
  await page.getByTestId("export").click();
  await page.getByTestId("export-size-small").click();
  await page.getByRole("button", { name: "Back" }).click();
  await page.getByTestId("export-size-full").click();

  const selections = (await events(page)).filter((e) => e.name === "export_tier_selected");
  expect(selections).toEqual([
    { name: "export_tier_selected", tier: "small", width: 640, height: 360 },
    { name: "export_tier_selected", tier: "full", width: 2560, height: 1440 },
  ]);
});

test("no event payload carries anything beyond the declared fields", async ({ page }) => {
  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("export").click();
  await page.getByTestId("export-size-small").click();
  await page.getByTestId("export-confirm").click();
  await downloadPromise;

  const allowed: Record<string, string[]> = {
    export_modal_opened: ["name"],
    export_tier_selected: ["name", "tier", "width", "height"],
    export_completed: ["name", "tier"],
    export_cancelled: ["name"],
  };

  for (const event of await events(page)) {
    expect(Object.keys(event).sort()).toEqual(allowed[event.name]!.sort());
  }
});

test("nothing reaches the network when no provider is installed", async ({ page }) => {
  // Re-navigate so this page installs no sink, restoring the shipping default.
  const external: string[] = [];
  page.on("request", (request) => {
    if (!request.url().startsWith("http://127.0.0.1:5173")) external.push(request.url());
  });

  await page.evaluate(() => window.__setAnalyticsSink(null));
  await page.getByTestId("export").click();
  await page.getByTestId("export-size-small").click();
  await page.getByTestId("export-confirm").click();
  await page.waitForTimeout(500);

  expect(external).toEqual([]);
});

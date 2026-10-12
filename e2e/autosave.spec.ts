import { expect, test, type Page } from "@playwright/test";
import { canvasLocator, clearCanvas, documentPixels, dragShape, drawStroke, setTool, setWidth } from "./helpers";

/**
 * Autosave verification.
 *
 * The load-bearing test here is "pixels are byte-identical after a reload". Until now replay
 * only ever ran in memory; this is the first time the determinism contract is relied on
 * across a session boundary.
 */

const DB_NAME = "paintpad";
const STORE = "documents";
const KEY = "current";

/** Write a raw value straight into the store, to simulate a corrupt or foreign save. */
async function writeRawSave(page: Page, value: string): Promise<void> {
  await page.evaluate(
    async ({ dbName, store, key, value }) => {
      await new Promise<void>((resolve, reject) => {
        const open = indexedDB.open(dbName, 1);
        open.onupgradeneeded = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
        };
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction(store, "readwrite");
          tx.objectStore(store).put(value, key);
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
        open.onerror = () => reject(open.error);
      });
    },
    { dbName: DB_NAME, store: STORE, key: KEY, value },
  );
}

/** Read the raw stored save, or null if there is none. */
function readRawSave(page: Page): Promise<string | null> {
  return page.evaluate(
    ({ dbName, store, key }) =>
      new Promise<string | null>((resolve) => {
        const open = indexedDB.open(dbName, 1);
        open.onupgradeneeded = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
        };
        open.onsuccess = () => {
          const db = open.result;
          const request = db.transaction(store, "readonly").objectStore(store).get(key);
          request.onsuccess = () => {
            const value = request.result;
            db.close();
            resolve(typeof value === "string" ? value : null);
          };
          request.onerror = () => {
            db.close();
            resolve(null);
          };
        };
        open.onerror = () => resolve(null);
      }),
    { dbName: DB_NAME, store: STORE, key: KEY },
  );
}

/** Reload and wait for the app to finish restoring. */
async function reload(page: Page): Promise<void> {
  await page.reload();
  await expect(canvasLocator(page)).toBeVisible();
  // The restore is async and happens before attach; give it a beat to land.
  await page.waitForTimeout(150);
}

/**
 * Wait until the store holds exactly what the engine currently holds.
 *
 * Comparing the whole encoded document rather than a field like the cursor: an empty
 * document and a not-yet-written save are indistinguishable by cursor alone, so a
 * cursor-based poll would pass against a stale save. Comparing the full form is also what
 * the app itself does before deciding a write is needed.
 */
async function waitForSave(page: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        const expected = await page.evaluate(() =>
          JSON.stringify(window.__paintpad.documentState()),
        );
        return (await readRawSave(page)) === expected;
      },
      { timeout: 30_000, intervals: [100, 250, 500] },
    )
    .toBe(true);
}

async function scribble(page: Page): Promise<void> {
  await setTool(page, "pencil");
  await setWidth(page, 5);
  await page.getByTestId("swatch-foreground").click();
  await page.locator('button[data-colour="#c00000"]').click();
  await drawStroke(page, { x: 80, y: 80 }, { x: 320, y: 260 }, { steps: 16 });
  await drawStroke(page, { x: 340, y: 100 }, { x: 140, y: 300 }, { steps: 16 });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(canvasLocator(page)).toBeVisible();
  await page.evaluate(() => localStorage.clear());
  // Clear wipes the autosave slot as well as the canvas, which is what isolates these tests:
  // IndexedDB persists for the origin across page loads, so without this a saved document
  // would leak from one test into the next.
  await clearCanvas(page);
  await waitForSave(page);
});

test("a drawn document survives a reload byte-identically", async ({ page }) => {
  await scribble(page);
  await waitForSave(page);
  const before = await documentPixels(page);

  await reload(page);

  expect(await documentPixels(page)).toEqual(before);
  expect(await page.evaluate(() => window.__paintpad.documentInkCount())).toBeGreaterThan(0);
});

test("a fill survives a reload", async ({ page }) => {
  // A fill stores {seed, colour, contiguous} rather than pixels, so this proves the record
  // re-derives the same region on replay rather than carrying its output.
  await setTool(page, "rect");
  await setWidth(page, 8);
  await page.getByTestId("swatch-foreground").click();
  await page.locator('button[data-colour="#000000"]').click();
  await dragShape(page, { x: 140, y: 100 }, { x: 420, y: 300 });

  await setTool(page, "fill");
  await page.getByTestId("swatch-foreground").click();
  await page.locator('button[data-colour="#f72585"]').click();
  const box = (await canvasLocator(page).boundingBox())!;
  await page.mouse.move(box.x + 280, box.y + 200);
  await page.mouse.down();
  await page.mouse.up();
  await waitForSave(page);

  const before = await documentPixels(page);
  await reload(page);
  expect(await documentPixels(page)).toEqual(before);
});

test("the undo position survives a reload, so redo still works", async ({ page }) => {
  await scribble(page);
  await waitForSave(page);

  await page.evaluate(() => window.__paintpad.undo());
  await waitForSave(page);
  const afterUndo = await documentPixels(page);

  await reload(page);

  // The document is at the same point in history...
  expect(await documentPixels(page)).toEqual(afterUndo);
  // ...and the abandoned future was not thrown away by the reload.
  expect(await page.evaluate(() => window.__paintpad.canRedo())).toBe(true);

  await page.evaluate(() => window.__paintpad.redo());
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.__paintpad.recordCount)).toBe(2);
});

test("work in flight survives an immediate reload", async ({ page }) => {
  // The debounce has a cost: without the flush-on-hide, the work in the last few hundred
  // milliseconds before a close is exactly the work that gets lost — the failure autosave
  // exists to prevent. Reloading with no wait is the sharpest version of that.
  await scribble(page);
  await page.reload();
  await expect(canvasLocator(page)).toBeVisible();
  await page.waitForTimeout(250);

  expect(await page.evaluate(() => window.__paintpad.settings().recordCount)).toBe(2);
  expect(await page.evaluate(() => window.__paintpad.documentInkCount())).toBeGreaterThan(0);
});

test("the canvas background survives a reload", async ({ page }) => {
  await page.getByTestId("swatch-background").click();
  await page.locator('button[data-colour="#ffd166"]').click();
  await waitForSave(page);

  expect(await page.evaluate(() => window.__paintpad.settings().background)).toBe("#ffd166");
  await reload(page);
  expect(await page.evaluate(() => window.__paintpad.settings().background)).toBe("#ffd166");
});

test("a corrupt save is discarded and the app still draws", async ({ page }) => {
  await writeRawSave(page, "{ this is not valid json");
  await reload(page);

  expect(await page.evaluate(() => window.__paintpad.recordCount)).toBe(0);

  // The point of the failure path: a bad save must not leave a broken editor.
  await scribble(page);
  await waitForSave(page);
  expect(await page.evaluate(() => window.__paintpad.documentInkCount())).toBeGreaterThan(0);
});

test("a save from an unknown version is discarded", async ({ page }) => {
  await writeRawSave(page, JSON.stringify({ v: 99, entries: [], cursor: 0 }));
  await reload(page);
  expect(await page.evaluate(() => window.__paintpad.recordCount)).toBe(0);
});

test("Clear wipes the save, so a reload comes back empty", async ({ page }) => {
  await scribble(page);
  await waitForSave(page);
  expect(await readRawSave(page)).not.toBeNull();

  await clearCanvas(page);
  await waitForSave(page);
  await reload(page);

  expect(await page.evaluate(() => window.__paintpad.recordCount)).toBe(0);
  expect(await page.evaluate(() => window.__paintpad.documentInkCount())).toBe(0);
});

test("the stored save is the command log, not pixels", async ({ page }) => {
  await scribble(page);
  await waitForSave(page);

  const raw = await readRawSave(page);
  expect(raw).not.toBeNull();

  const parsed = JSON.parse(raw!) as {
    v: number;
    entries: { kind: string }[];
    cursor: number;
    doc: { logicalWidth: number; rasterScale: number };
  };
  expect(parsed.v).toBe(1);
  expect(parsed.entries).toHaveLength(2);
  expect(parsed.entries.every((e) => e.kind === "stroke")).toBe(true);
  expect(parsed.cursor).toBe(2);
  expect(parsed.doc.logicalWidth).toBe(1280);
  expect(parsed.doc.rasterScale).toBe(2);

  // Compact enough to be worth persisting: two strokes must not be megabytes.
  expect(raw!.length).toBeLessThan(10_000);
});
import { test, expect, openLog, type Page } from "./support/fixtures";

// A log row located by its 1-based line number. Scope the match to the gutter
// (`.log-gut`) so a bare digit in the log *text* can't select the wrong row.
function logRow(page: Page, n: number) {
  return page.locator(".log-row").filter({
    has: page.locator(".log-gut", { hasText: new RegExp(`^${n}$`) }),
  });
}

// Add a bookmark on a line via the gutter marker + editor popover.
async function addBookmark(
  page: Page,
  n: number,
  opts: { icon?: string; note?: string } = {},
) {
  await logRow(page, n).locator(".log-mark").click();
  const pop = page.locator(".marker-pop");
  await expect(pop).toBeVisible();
  if (opts.icon) await pop.getByRole("button", { name: opts.icon }).click();
  if (opts.note) await pop.locator(".mp-note").fill(opts.note);
  await pop.getByRole("button", { name: "Done" }).click();
  await expect(pop).toBeHidden();
}

const openBookmarksTab = (page: Page) =>
  page.getByRole("button", { name: "Bookmarks" }).click();

const bmRows = (page: Page) => page.locator(".bm-row");

test.describe("Bookmarks", () => {
  test.beforeEach(async ({ page, tauri }) => {
    await openLog(page, tauri);
  });

  test("the panel is empty until a bookmark is added", async ({ page }) => {
    await openBookmarksTab(page);
    await expect(page.getByText("No bookmarks yet")).toBeVisible();
  });

  test("adding from the gutter marks the row and lists it", async ({
    page,
  }) => {
    await addBookmark(page, 3);

    // The gutter marker becomes active on the bookmarked row.
    await expect(logRow(page, 3).locator(".log-mark.on")).toBeVisible();

    await openBookmarksTab(page);
    await expect(bmRows(page)).toHaveCount(1);
    await expect(page.locator(".bm-line")).toHaveText("3");
  });

  test("a bookmark can carry a note and previews the line", async ({
    page,
  }) => {
    await addBookmark(page, 4, { note: "look here" });

    await openBookmarksTab(page);
    await expect(page.locator(".bm-title")).toHaveText("look here");
    await expect(page.locator(".bm-preview")).toContainText(
      "ERROR sensor timeout",
    );
  });

  test("jumping from the panel selects the line", async ({ page }) => {
    await addBookmark(page, 6);
    await openBookmarksTab(page);

    await page.locator(".bm-jump").click();

    const selected = page.locator(".log-row.selected");
    await expect(selected).toHaveCount(1);
    await expect(selected.locator(".log-gut")).toHaveText("6");
  });

  test("removing from the panel clears the row marker", async ({ page }) => {
    await addBookmark(page, 3);
    await openBookmarksTab(page);

    await page.locator(".bm-del").click();

    await expect(page.getByText("No bookmarks yet")).toBeVisible();
    await expect(logRow(page, 3).locator(".log-mark.on")).toHaveCount(0);
  });

  test("re-opening the editor offers Remove", async ({ page }) => {
    await addBookmark(page, 2);

    // Click the (now active) gutter marker again to edit it.
    await logRow(page, 2).locator(".log-mark").click();
    const pop = page.locator(".marker-pop");
    await pop.getByRole("button", { name: "Remove" }).click();

    await expect(logRow(page, 2).locator(".log-mark.on")).toHaveCount(0);
  });

  test("clear all empties the panel", async ({ page }) => {
    await addBookmark(page, 2);
    await addBookmark(page, 5);
    await openBookmarksTab(page);
    await expect(bmRows(page)).toHaveCount(2);

    await page.getByRole("button", { name: "Clear all" }).click();
    await expect(page.getByText("No bookmarks yet")).toBeVisible();
  });

  test("icon filter chips narrow the list by glyph", async ({ page }) => {
    await addBookmark(page, 2); // default "bookmark" icon
    await addBookmark(page, 5, { icon: "Star" });
    await openBookmarksTab(page);

    const chips = page.locator(".bm-chip");
    // All + the two distinct icons in use.
    await expect(chips).toHaveCount(3);
    await expect(chips.first()).toContainText("2");

    // The star chip (located by its glyph, not position) filters to that one.
    await chips.filter({ has: page.locator(".lucide-star") }).click();
    await expect(bmRows(page)).toHaveCount(1);
    await expect(page.locator(".bm-line")).toHaveText("5");
  });
});

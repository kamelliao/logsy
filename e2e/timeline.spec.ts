import {
  test,
  expect,
  openLog,
  addFilter,
  filterRow,
  logRowMenu,
  openTab,
  STRUCTURED_LOG,
  STRUCTURED_PATTERN,
  type Page,
} from "./support/fixtures";

// Add the parse filter (named groups; `t` is numeric) and plot its `t` field as a
// timeline track via the filter row's menu. The filter carries a description so
// its row is easy to locate.
async function addTrack(page: Page) {
  await addFilter(page, STRUCTURED_PATTERN, { regex: true, description: "ev" });
  await filterRow(page, "ev").getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Timeline tracks" }).click();
  await page.getByRole("menuitem", { name: "t", exact: true }).click();
}

// The sheet's "N events · M lines" line (not the contextual hint span).
const counts = (page: Page) =>
  page.locator(".tl-sheet-counts", { hasText: "line" });

// A track row, identified by its drag grip — this excludes the hidden dnd-kit
// a11y live-region divs that are also direct children of .tl-sheet-body.
const trackRow = (page: Page) =>
  page
    .locator(".tl-sheet-body > div")
    .filter({ has: page.locator(".cursor-grab") });

// Run a per-track action by name. The row's buttons collapse into a "⋯ Track
// actions" menu on a narrow dock and sit inline when it's wide — handle both.
async function trackAction(page: Page, name: string) {
  const more = trackRow(page).getByRole("button", { name: "Track actions" });
  if (await more.isVisible()) {
    await more.click();
    await page.getByRole("menuitem", { name }).click();
  } else {
    await trackRow(page).getByRole("button", { name }).click();
  }
}

test.describe("Timeline", () => {
  test.beforeEach(async ({ page, tauri }) => {
    await openLog(page, tauri, "/logs/s.log", STRUCTURED_LOG);
  });

  test("shows the empty state until a track is added", async ({ page }) => {
    await openTab(page, "Timeline");
    await expect(page.getByText("No tracks yet")).toBeVisible();
  });

  test("adding a track from a filter shows it in the sheet", async ({
    page,
  }) => {
    await addTrack(page);
    await openTab(page, "Timeline");

    await expect(trackRow(page)).toHaveCount(1);
    await expect(page.locator(".tl-sheet-body")).toContainText("#1:t");
    await expect(page.locator(".tl-sheet-body")).toContainText("ev");
  });

  test("adding log lines plots events (sheet counts update)", async ({
    page,
  }) => {
    await addTrack(page);
    await logRowMenu(page, 1, "Add to timeline");
    await openTab(page, "Timeline");

    await expect(counts(page)).toContainText("1 event");
    await expect(counts(page)).toContainText("1 line");
  });

  test("the 'add all matching lines' hint plots every line", async ({
    page,
  }) => {
    await addTrack(page);
    await openTab(page, "Timeline");

    await page.getByRole("button", { name: "add all matching lines" }).click();
    await expect(counts(page)).toContainText("4 events");
    await expect(counts(page)).toContainText("4 lines");
  });

  test("renames a track by double-clicking its lane", async ({ page }) => {
    await addTrack(page);
    await openTab(page, "Timeline");

    await page.locator(".tl-sheet-body .cursor-text").dblclick();
    // base-ui Selects render hidden inputs; the rename field is the only textbox.
    const input = page.locator(".tl-sheet-body").getByRole("textbox");
    await expect(input).toBeVisible();
    await input.fill("clock");
    await input.press("Enter");

    await expect(page.locator(".tl-sheet-body")).toContainText("clock");
  });

  test("deletes a track, returning to the empty state", async ({ page }) => {
    await addTrack(page);
    await openTab(page, "Timeline");
    await expect(trackRow(page)).toHaveCount(1);

    await trackAction(page, "Delete track");
    await expect(page.getByText("No tracks yet")).toBeVisible();
  });
});

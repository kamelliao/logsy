import {
  test,
  expect,
  openLog,
  addFilter,
  filterRow,
  logRowMenu,
  openTab,
  dragTo,
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

// The sheet's "N events · M lines" line. It's always the first .tl-sheet-counts;
// a contextual hint (also .tl-sheet-counts) may follow when nothing is plotted.
const counts = (page: Page) => page.locator(".tl-sheet-counts").first();

// A track row, identified by its drag grip — this excludes the hidden dnd-kit
// a11y live-region divs that are also direct children of .tl-sheet-body.
const trackRow = (page: Page) =>
  page
    .locator(".tl-sheet-body > div")
    .filter({ has: page.locator(".cursor-grab") });

// Run a per-track action. The row's buttons collapse into a "⋯ Track actions"
// menu on a narrow dock and sit inline (by title) when it's wide — handle both.
// `inlineTitle` is the icon button's title; `menuLabel` the overflow item's text
// (they differ for import/clear, and default to the same string otherwise).
async function trackAction(
  page: Page,
  inlineTitle: string,
  menuLabel?: string,
) {
  const more = trackRow(page).getByRole("button", { name: "Track actions" });
  if (await more.isVisible()) {
    await more.click();
    await page
      .getByRole("menuitem", { name: menuLabel ?? inlineTitle })
      .click();
  } else {
    await trackRow(page).getByRole("button", { name: inlineTitle }).click();
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

  test("Import matching pulls every line onto the track", async ({ page }) => {
    await addTrack(page);
    await openTab(page, "Timeline");

    await trackAction(
      page,
      "Import this track's matching lines onto the timeline",
      "Import matching lines",
    );
    await expect(counts(page)).toContainText("4 events");
    await expect(counts(page)).toContainText("4 lines");
  });

  test("Remove lines clears the track's events", async ({ page }) => {
    await addTrack(page);
    await openTab(page, "Timeline");
    await trackAction(
      page,
      "Import this track's matching lines onto the timeline",
      "Import matching lines",
    );
    await expect(counts(page)).toContainText("4 events");

    await trackAction(
      page,
      "Remove this track's lines from the timeline",
      "Remove lines from timeline",
    );
    await expect(counts(page)).toContainText("0 events");
  });

  test("Hiding a track drops its events from the plot", async ({ page }) => {
    await addTrack(page);
    await openTab(page, "Timeline");
    await trackAction(
      page,
      "Import this track's matching lines onto the timeline",
      "Import matching lines",
    );
    await expect(counts(page)).toContainText("4 events");

    // Hidden tracks are excluded from the marks (lines stay added).
    await trackAction(page, "Hide track");
    await expect(counts(page)).toContainText("0 events");
    await expect(counts(page)).toContainText("4 lines");
  });
});

// Spans and track reordering need a filter with two numeric fields.
const SPAN_LOG = ["req 0.10 done 0.15", "req 0.20 done 0.45"].join("\n");
const SPAN_PATTERN = "req (?<start>[0-9.]+) done (?<end>[0-9.]+)";

const trackRows = (page: Page) =>
  page
    .locator(".tl-sheet-body > div")
    .filter({ has: page.locator(".cursor-grab") });

// Plot one of the filter's numeric fields as a track.
async function addTrackField(page: Page, field: string) {
  await filterRow(page, "span").getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Timeline tracks" }).click();
  await page.getByRole("menuitem", { name: field, exact: true }).click();
}

test.describe("Timeline spans & reorder", () => {
  test.beforeEach(async ({ page, tauri }) => {
    await openLog(page, tauri, "/logs/span.log", SPAN_LOG);
    await addFilter(page, SPAN_PATTERN, { regex: true, description: "span" });
  });

  test("adds an end field to draw a span", async ({ page }) => {
    await addTrackField(page, "start");
    await openTab(page, "Timeline");

    // "Add an end field" → pick `end`; the row then exposes a remove-end control.
    await page
      .locator(".tl-sheet-body")
      .getByRole("button", { name: "Add an end field" })
      .click();
    await page.getByRole("option", { name: "end" }).click();

    await expect(
      page.getByRole("button", { name: "Remove end field (make it a point)" }),
    ).toBeVisible();
  });

  test("reorders tracks by dragging the grip", async ({ page }) => {
    await addTrackField(page, "start");
    await addTrackField(page, "end");
    await openTab(page, "Timeline");
    await expect(trackRows(page)).toHaveCount(2);

    const lanesBefore = await page
      .locator(".tl-sheet-body .cursor-text")
      .allInnerTexts();
    expect(lanesBefore).toEqual(["#1:start", "#1:end"]);

    await dragTo(
      page,
      trackRows(page).nth(0).locator(".cursor-grab"),
      trackRows(page).nth(1).locator(".cursor-grab"),
    );

    const lanesAfter = await page
      .locator(".tl-sheet-body .cursor-text")
      .allInnerTexts();
    expect(lanesAfter).toEqual(["#1:end", "#1:start"]);
  });
});

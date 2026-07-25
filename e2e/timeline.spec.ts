import {
  test,
  expect,
  openLog,
  addFilter,
  filterRow,
  logRow,
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

  // The one submenu trigger in the row menu (its label pluralizes for a multi-select).
  const sub = (page: Page) => page.locator(".row-menu .menu-item.has-sub");
  const subField = (page: Page, name: string) =>
    sub(page).locator(".row-submenu .menu-item", { hasText: name });

  test("un-checking a time field keeps the line's OTHER fields plotted", async ({
    page,
  }) => {
    // Plot line 1 on both `end` and `start` (two lanes of the same filter).
    await logRow(page, 1).click({ button: "right" });
    await sub(page).hover();
    await subField(page, "end").click();
    await logRow(page, 1).click({ button: "right" });
    await sub(page).hover();
    await subField(page, "start").click();

    await openTab(page, "Timeline");
    await expect(trackRows(page)).toHaveCount(2);
    await expect(counts(page)).toContainText("2 events");

    // Un-check `end`: the line drops off the END lane only — it stays on START, and
    // both lanes (tracks) remain defined (empty lanes are kept, not deleted).
    await logRow(page, 1).click({ button: "right" });
    await sub(page).hover();
    await expect(subField(page, "end")).toHaveClass(/\bon\b/);
    await subField(page, "end").click();

    await expect(counts(page)).toContainText("1 event");
    await expect(trackRows(page)).toHaveCount(2);
    await expect(page.locator(".tl-sheet-body")).toContainText("#1:start");
    await expect(page.locator(".tl-sheet-body")).toContainText("#1:end");
  });

  test("adding a line to one field does NOT plot it on other lanes", async ({
    page,
  }) => {
    // Both lanes already exist in the panel (no lines yet).
    await addTrackField(page, "start");
    await addTrackField(page, "end");
    await openTab(page, "Timeline");
    await expect(trackRows(page)).toHaveCount(2);

    // Add line 1 to `start` ONLY. It must not also land on the `end` lane just
    // because that lane exists — one event, on start.
    await logRow(page, 1).click({ button: "right" });
    await sub(page).hover();
    await subField(page, "start").click();

    await expect(counts(page)).toContainText("1 event");
    await expect(counts(page)).toContainText("1 line");

    // Confirm the menu agrees: start is ticked, end is not.
    await logRow(page, 1).click({ button: "right" });
    await sub(page).hover();
    await expect(subField(page, "start")).toHaveClass(/\bon\b/);
    await expect(subField(page, "end")).not.toHaveClass(/\bon\b/);
  });

  test("a multi-line selection adds all lines on the picked field", async ({
    page,
  }) => {
    // Select both lines (click line 1, shift-click line 2), then add the batch to
    // `start` in one go. The submenu row shows plotted/applicable across the batch.
    await logRow(page, 1).click();
    await logRow(page, 2).click({ modifiers: ["Shift"] });
    await logRow(page, 1).click({ button: "right" });
    // The trigger pluralizes with the selection size, like "Add N lines to compare".
    await expect(sub(page)).toContainText("Add 2 lines to timeline");
    await sub(page).hover();
    // Before adding: 0 of 2 lines plotted on start.
    await expect(subField(page, "start")).toContainText("0/2");
    await subField(page, "start").click();

    await openTab(page, "Timeline");
    await expect(trackRows(page)).toHaveCount(1);
    await expect(page.locator(".tl-sheet-body")).toContainText("#1:start");
    await expect(counts(page)).toContainText("2 events");
    await expect(counts(page)).toContainText("2 lines");

    // The submenu now reflects the batch as fully plotted on start, not on end.
    await logRow(page, 1).click();
    await logRow(page, 2).click({ modifiers: ["Shift"] });
    await logRow(page, 1).click({ button: "right" });
    await sub(page).hover();
    await expect(subField(page, "start")).toContainText("2/2");
    await expect(subField(page, "start")).toHaveClass(/\bon\b/);
    await expect(subField(page, "end")).toContainText("0/2");
    await expect(subField(page, "end")).not.toHaveClass(/\bon\b/);
  });

  test("the per-track line badge counts only its OWN lane", async ({
    page,
  }) => {
    // The a/b badge on each track row: `a` = lines on THIS lane, `b` = matchable.
    // Adding/removing a line on one field must move only that lane's `a`.
    const laneBadge = (lane: string) =>
      trackRows(page)
        .filter({ hasText: lane })
        .locator('span[title*="on the timeline"]');

    await addTrackField(page, "start");
    await addTrackField(page, "end");
    await openTab(page, "Timeline");

    // Add line 1 to `start` only → start badge 1/2, end stays 0/2.
    await logRow(page, 1).click({ button: "right" });
    await sub(page).hover();
    await subField(page, "start").click();
    await expect(laneBadge("#1:start")).toHaveText("1/2");
    await expect(laneBadge("#1:end")).toHaveText("0/2");

    // Also add line 1 to `end` → both lanes now 1/2.
    await logRow(page, 1).click({ button: "right" });
    await sub(page).hover();
    await subField(page, "end").click();
    await expect(laneBadge("#1:start")).toHaveText("1/2");
    await expect(laneBadge("#1:end")).toHaveText("1/2");

    // Remove line 1 from `start` → start drops to 0/2 IMMEDIATELY; end keeps 1/2
    // (not held until every field is removed).
    await logRow(page, 1).click({ button: "right" });
    await sub(page).hover();
    await subField(page, "start").click();
    await expect(laneBadge("#1:start")).toHaveText("0/2");
    await expect(laneBadge("#1:end")).toHaveText("1/2");
  });

  test("un-checking one line keeps the lane's OTHER lines", async ({
    page,
  }) => {
    // Both lines share the `end` lane (no start track).
    await logRow(page, 1).click({ button: "right" });
    await sub(page).hover();
    await subField(page, "end").click();
    await logRow(page, 2).click({ button: "right" });
    await sub(page).hover();
    await subField(page, "end").click();

    await openTab(page, "Timeline");
    await expect(trackRows(page)).toHaveCount(1);
    await expect(counts(page)).toContainText("2 events");
    await expect(counts(page)).toContainText("2 lines");

    // Remove line 1 from `end`. `end` is line 1's only lane, so line 1 leaves the
    // timeline — but the lane stays and line 2 is still plotted on it.
    await logRow(page, 1).click({ button: "right" });
    await sub(page).hover();
    await subField(page, "end").click();

    await expect(trackRows(page)).toHaveCount(1);
    await expect(page.locator(".tl-sheet-body")).toContainText("#1:end");
    await expect(counts(page)).toContainText("1 event");
    await expect(counts(page)).toContainText("1 line");
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

// A selection spanning TWO filters: each keeps its own fields, labelled by lane.
test.describe("Timeline cross-filter selection", () => {
  const TWO_FILTER_LOG = ["boot ts=100", "http dur=5"].join("\n");

  test.beforeEach(async ({ page, tauri }) => {
    await openLog(page, tauri, "/logs/x.log", TWO_FILTER_LOG);
    await addFilter(page, "boot ts=(?<ts>\\d+)", {
      regex: true,
      description: "boot",
    });
    await addFilter(page, "http dur=(?<dur>\\d+)", {
      regex: true,
      description: "http",
    });
  });

  const sub = (page: Page) => page.locator(".row-menu .menu-item.has-sub");
  const field = (page: Page, name: string) =>
    sub(page).locator(".row-submenu .menu-item", { hasText: name });

  test("groups fields into per-filter sections and scopes the add", async ({
    page,
  }) => {
    // Select line 1 (filter #1 `ts`) + line 2 (filter #2 `dur`).
    await logRow(page, 1).click();
    await logRow(page, 2).click({ modifiers: ["Shift"] });
    await logRow(page, 1).click({ button: "right" });
    await sub(page).hover();

    // Cross-filter → a section header per filter, fields grouped under them.
    await expect(
      sub(page).locator(".row-submenu .menu-section", { hasText: "#1 boot" }),
    ).toBeVisible();
    await expect(
      sub(page).locator(".row-submenu .menu-section", { hasText: "#2 http" }),
    ).toBeVisible();
    // One (filter, field) row each; each applies to 1 of the 2 selected lines.
    await expect(field(page, "ts")).toContainText("0/1");
    await expect(field(page, "dur")).toContainText("0/1");

    // Adding `ts` (under #1) plots ONLY line 1 — line 2's filter is untouched.
    await field(page, "ts").click();
    await openTab(page, "Timeline");
    await expect(trackRows(page)).toHaveCount(1);
    await expect(page.locator(".tl-sheet-body")).toContainText("#1:ts");
    await expect(counts(page)).toContainText("1 event");
    await expect(counts(page)).toContainText("1 line");
  });
});

// Both the row menu and its "Add to timeline" flyout must stay on-screen when opened
// from a row low in the viewport (they used to spill off the bottom and get clipped).
test.describe("Timeline row menu clamping", () => {
  const TALL_LOG = Array.from(
    { length: 80 },
    (_, i) => `req 0.${10 + i} done 0.${30 + i}`,
  ).join("\n");

  test.beforeEach(async ({ page, tauri }) => {
    await openLog(page, tauri, "/logs/tall.log", TALL_LOG);
    await addFilter(page, SPAN_PATTERN, { regex: true, description: "span" });
  });

  test("the menu and flyout stay within the viewport near the bottom", async ({
    page,
  }) => {
    const vh = page.viewportSize()!.height;
    // Right-click the lowest rendered row — its menu anchors near the bottom edge.
    await page.locator(".log-row").last().click({ button: "right" });

    const menu = page.locator(".row-menu");
    await expect(menu).toBeVisible();
    const mBox = await menu.boundingBox();
    expect(mBox!.y + mBox!.height).toBeLessThanOrEqual(vh);

    // Open the flyout (span has two fields) and check it too.
    const trigger = menu.locator(".menu-item.has-sub");
    await trigger.hover();
    const fly = page.locator(".row-submenu");
    await expect(fly).toBeVisible();
    const fBox = await fly.boundingBox();
    expect(fBox!.y + fBox!.height).toBeLessThanOrEqual(vh);
    expect(fBox!.y).toBeGreaterThanOrEqual(0);
  });
});

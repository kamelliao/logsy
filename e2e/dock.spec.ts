import {
  test,
  expect,
  openLog,
  logRowMenu,
  type Page,
} from "./support/fixtures";

// The dock: the tabbed panel (Filters / Timeline / Compare / Notebook)
// and the shared side dock panels can be POPPED OUT into, so two can be read at
// once. Any panel can be popped — the main dock just always keeps at least one.
//
// The two docks are addressed by `data-dock`, not DOM order: the popped dock renders
// BEFORE the main one whenever the main dock is right-docked (the default).

const mainDock = (page: Page) => page.locator('[data-dock="main"]');
const popDock = (page: Page) => page.locator('[data-dock="popped"]');
const tabsOf = (dock: ReturnType<typeof mainDock>) =>
  dock.locator(".ptab").allTextContents();

/** Reveal a panel on the main dock, then pop it out to the side. */
async function popOut(page: Page, panel: string) {
  await mainDock(page).locator(".ptab", { hasText: panel }).click();
  await page
    .getByRole("button", { name: new RegExp(`Pop ${panel} out`) })
    .click();
}

test.describe("dock — popping panels out", () => {
  test.beforeEach(async ({ page, tauri }) => {
    await openLog(page, tauri);
    // Only the main dock to start with.
    await expect(page.locator(".panel-dock")).toHaveCount(1);
  });

  test("Filters can be popped out into the side dock", async ({ page }) => {
    await popOut(page, "Filters");

    await expect(page.locator(".panel-dock")).toHaveCount(2);
    expect(await tabsOf(popDock(page))).toEqual(["Filters"]);
    expect(await tabsOf(mainDock(page))).toEqual([
      "Timeline",
      "Compare",
      "Notebook",
    ]);
    // The panel's real body moved with it — not just the tab.
    await expect(popDock(page).locator(".filter-panel")).toBeVisible();
    // …and the main dock fell back to a tab that is actually still on it.
    await expect(mainDock(page).locator(".ptab.active")).toHaveText("Timeline");
  });

  test("Timeline and Notebook can be popped out too", async ({ page }) => {
    await popOut(page, "Timeline");
    await popOut(page, "Notebook");

    expect(await tabsOf(popDock(page))).toEqual(["Timeline", "Notebook"]);
    expect(await tabsOf(mainDock(page))).toEqual(["Filters", "Compare"]);
    // The side dock is a tab strip like any other: switch between what's on it.
    await popDock(page).locator(".ptab", { hasText: "Timeline" }).click();
    await expect(popDock(page).locator(".ptab.active")).toHaveText("Timeline");
  });

  test("the main dock always keeps at least one tab", async ({ page }) => {
    await popOut(page, "Filters");
    await popOut(page, "Notebook");
    await popOut(page, "Timeline");

    // One panel left — and no way to pop it, or the main dock would be empty.
    expect(await tabsOf(mainDock(page))).toEqual(["Compare"]);
    await expect(page.getByRole("button", { name: /Pop .+ out/ })).toHaveCount(
      0,
    );
  });

  test("a popped panel can be docked back, and lands focused", async ({
    page,
  }) => {
    await popOut(page, "Filters");
    await popOut(page, "Timeline");
    expect(await tabsOf(popDock(page))).toEqual(["Filters", "Timeline"]);

    await popDock(page).locator(".ptab", { hasText: "Filters" }).click();
    await page.getByRole("button", { name: /Dock Filters back/ }).click();

    expect(await tabsOf(popDock(page))).toEqual(["Timeline"]);
    // Back on the main dock, in canonical order, and focused there.
    expect(await tabsOf(mainDock(page))).toEqual([
      "Filters",
      "Compare",
      "Notebook",
    ]);
    await expect(mainDock(page).locator(".ptab.active")).toHaveText("Filters");
  });

  test("docking the last popped panel back removes the side dock", async ({
    page,
  }) => {
    await popOut(page, "Compare");
    await expect(page.locator(".panel-dock")).toHaveCount(2);

    await page.getByRole("button", { name: /Dock Compare back/ }).click();
    await expect(page.locator(".panel-dock")).toHaveCount(1);
    await expect(popDock(page)).toHaveCount(0);
  });

  // Actions that REVEAL a panel ("add to notebook", "add to timeline",
  // jump-to-filter, …) must find it wherever it lives — otherwise popping a panel
  // out would silently break them, with the action appearing to do nothing.
  test("adding to the notebook surfaces it even while it is popped out", async ({
    page,
  }) => {
    await popOut(page, "Notebook");
    // Collapse the side dock, so surfacing the panel has to expand it again.
    await popDock(page)
      .locator(".dock-head")
      .getByRole("button", { name: "Collapse", exact: true })
      .click();
    await expect(popDock(page).locator(".dock-body")).toHaveCount(0);

    await logRowMenu(page, 1, /Add to notebook/);

    // The Notebook is showing, on the dock it actually lives on.
    await expect(popDock(page).locator(".ptab.active")).toHaveText("Notebook");
    await expect(popDock(page).locator(".pl-card")).toBeVisible();
  });

  // Regression: `activePanelTab` is deferred (useDeferredValue), so for one frame
  // after a pop-out it still named the panel the popped dock had ALREADY taken —
  // mounting that panel's body on both docks at once. The notebook's TipTap editor
  // registers a KEYED ProseMirror plugin, so the second instance threw
  // ("Adding different instances of a keyed plugin (dragHandle$)") and blanked the
  // whole app until a reload.
  test("popping the Notebook out does not blank the app", async ({ page }) => {
    const crashes: string[] = [];
    page.on("pageerror", (e) => crashes.push(String(e)));

    // Put the notebook editor on screen first, so the TipTap instance is live.
    await mainDock(page).locator(".ptab", { hasText: "Notebook" }).click();
    await page.getByRole("button", { name: "New notebook" }).click();
    await expect(page.locator(".nb-prosemirror .ProseMirror")).toBeVisible();

    await page.getByRole("button", { name: /Pop Notebook out/ }).click();

    // It moved to the side dock, still alive — and exactly ONE editor exists.
    await expect(popDock(page).locator(".ptab.active")).toHaveText("Notebook");
    await expect(page.locator(".nb-prosemirror .ProseMirror")).toHaveCount(1);
    // The workspace is still there (the crash unmounted everything).
    await expect(page.locator(".logview")).toBeVisible();
    expect(crashes).toEqual([]);
  });

  test("the dock arrangement survives a reload", async ({ page }) => {
    await popOut(page, "Filters");
    await popOut(page, "Notebook");
    const mainBefore = await tabsOf(mainDock(page));
    const popBefore = await tabsOf(popDock(page));
    await page.waitForTimeout(450); // the doc write is debounced 300ms

    await page.reload();
    await expect(page.locator(".panel-dock")).toHaveCount(2);
    expect(await tabsOf(mainDock(page))).toEqual(mainBefore);
    expect(await tabsOf(popDock(page))).toEqual(popBefore);
  });
});

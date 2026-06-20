import {
  test,
  expect,
  openLog,
  addFilter,
  fillNewFilter,
  filterRow,
  rowMenu,
  panelMenu,
  addGroup,
  addSet,
  enterSelectMode,
  confirmDialog,
  dragTo,
  type Page,
} from "./support/fixtures";

// All FilterPanel e2e lives here, one describe per feature area. Keeping a panel's
// tests in a single file (rather than one file per suite) keeps the top-level e2e
// dir readable as more panels are covered; Playwright still parallelizes the
// individual tests across workers (fullyParallel).

const section = (page: Page) => page.locator(".fsection");

function setTab(page: Page, name: string) {
  return page
    .locator(".gtab")
    .filter({ has: page.getByText(name, { exact: true }) });
}

// In select mode base-ui marks the row (a hover-card trigger) as disabled, which
// trips Playwright's actionability check even though a real user clicks it fine.
// Force the click so it still dispatches to the row's onClick (drives selection).
function clickRow(
  page: Page,
  label: string,
  opts?: { modifiers?: ("Shift" | "ControlOrMeta")[] },
) {
  return filterRow(page, label).click({ ...opts, force: true });
}

// Add a filter into the (single) group via its "+" button.
async function addFilterToGroup(page: Page, pattern: string) {
  await section(page)
    .getByRole("button", { name: "Add filter to this group" })
    .click();
  await fillNewFilter(page, pattern);
}

// Drag/drop helpers read order from `.filter-list` so they ignore the dnd
// DragOverlay and hover-card portals (rendered at <body>, outside the list).
const listLabels = (page: Page) =>
  page.locator(".filter-list .fr-pattern").allTextContents();

test.describe("FilterPanel", () => {
  test.beforeEach(async ({ page, tauri }) => {
    await openLog(page, tauri);
  });

  // ---- Suite A: rows ----
  test.describe("rows", () => {
    test("shows the pattern, or the description when one is set", async ({
      page,
    }) => {
      await addFilter(page, "wifi");
      await expect(filterRow(page, "wifi").locator(".fr-pattern")).toHaveText(
        "wifi",
      );

      await addFilter(page, "ERROR", { description: "Error lines" });
      await expect(
        filterRow(page, "Error lines").locator(".fr-pattern"),
      ).toHaveText("Error lines");
    });

    test("numbers rows with 1-based serials in order", async ({ page }) => {
      await addFilter(page, "wifi");
      await addFilter(page, "ERROR");

      const serials = page.locator(".fr-serial");
      await expect(serials).toHaveCount(2);
      await expect(serials.nth(0)).toHaveText("#1");
      await expect(serials.nth(1)).toHaveText("#2");
    });

    test("renders flag badges for case / regex / exclude", async ({ page }) => {
      await addFilter(page, "err", { regex: true, caseSensitive: true });
      const row = filterRow(page, "err");
      await expect(row.locator(".fr-flag", { hasText: "Aa" })).toBeVisible();
      await expect(row.locator(".fr-flag", { hasText: ".*" })).toBeVisible();

      await addFilter(page, "wifi", { exclude: true });
      await expect(
        filterRow(page, "wifi").locator(".fr-flag.ex"),
      ).toBeVisible();
    });

    test("shows a hit count matching the log", async ({ page }) => {
      await addFilter(page, "ERROR", { regex: true });
      await expect(filterRow(page, "ERROR").locator(".fr-count")).toContainText(
        "2",
      );
    });

    test("clicking a row opens the editor and edits persist", async ({
      page,
    }) => {
      await addFilter(page, "wifi");
      await filterRow(page, "wifi").click();

      const dialog = page
        .getByRole("dialog")
        .filter({ hasText: "Edit filter" });
      await expect(dialog).toBeVisible();
      await dialog.getByPlaceholder("e.g.  wifi").fill("ERROR");
      await dialog.getByRole("button", { name: "Save" }).click();
      await expect(dialog).toBeHidden();

      await expect(filterRow(page, "ERROR")).toBeVisible();
      await expect(filterRow(page, "wifi")).toHaveCount(0);
    });

    test("the row menu offers edit/duplicate/delete and duplicate works", async ({
      page,
    }) => {
      await addFilter(page, "wifi");

      await filterRow(page, "wifi")
        .getByRole("button", { name: "More" })
        .click();
      await expect(page.getByRole("menuitem", { name: "Edit" })).toBeVisible();
      await expect(
        page.getByRole("menuitem", { name: "Duplicate" }),
      ).toBeVisible();
      await expect(
        page.getByRole("menuitem", { name: "Delete" }),
      ).toBeVisible();
      await page.getByRole("menuitem", { name: "Duplicate" }).click();

      await expect(filterRow(page, "wifi")).toHaveCount(2);
    });

    test("deleting a row removes it immediately and renumbers", async ({
      page,
    }) => {
      await addFilter(page, "wifi");
      await addFilter(page, "ERROR");

      await rowMenu(page, "wifi", "Delete");

      await expect(filterRow(page, "wifi")).toHaveCount(0);
      await expect(page.locator(".fr-serial")).toHaveCount(1);
      await expect(page.locator(".fr-serial")).toHaveText("#1");
    });
  });

  // ---- Suite B: enable toggle ----
  test.describe("enable toggle", () => {
    test("toggling the checkbox disables/enables the filter and its highlights", async ({
      page,
    }) => {
      await addFilter(page, "wifi");
      await expect(page.locator(".log-row.matched")).toHaveCount(2);

      const row = filterRow(page, "wifi");
      await row.getByRole("checkbox").click();
      await expect(row).toHaveClass(/disabled/);
      await expect(page.locator(".log-row.matched")).toHaveCount(0);

      await row.getByRole("checkbox").click();
      await expect(row).not.toHaveClass(/disabled/);
      await expect(page.locator(".log-row.matched")).toHaveCount(2);
    });

    test("clicking the checkbox does not open the editor", async ({ page }) => {
      await addFilter(page, "wifi");
      await filterRow(page, "wifi").getByRole("checkbox").click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
    });

    test("each row shows a colour swatch", async ({ page }) => {
      await addFilter(page, "wifi");
      const swatch = filterRow(page, "wifi").locator(".fr-color");
      await expect(swatch).toBeVisible();
      const bg = await swatch.evaluate(
        (el) => getComputedStyle(el).backgroundColor,
      );
      expect(bg).not.toBe("rgba(0, 0, 0, 0)");
    });
  });

  // ---- Suite (matching behaviour over the log) ----
  test.describe("matching behaviour", () => {
    test("a plain-text filter highlights matches and dims the rest", async ({
      page,
    }) => {
      await addFilter(page, "wifi");
      await expect(page.locator(".log-row.matched")).toHaveCount(2);
      await expect(page.locator(".log-row.dim")).toHaveCount(6);
    });

    test("an exclude filter hides matching lines", async ({ page }) => {
      await addFilter(page, "wifi", { exclude: true });
      await expect(page.locator(".log-row")).toHaveCount(6);
      await expect(page.locator(".log-txt", { hasText: "wifi" })).toHaveCount(
        0,
      );
    });

    test("a regex filter matches across alternatives", async ({ page }) => {
      await addFilter(page, "ERROR|WARN", { regex: true });
      await expect(page.locator(".log-row.matched")).toHaveCount(3);
    });

    test("case-insensitive matching ignores letter case by default", async ({
      page,
    }) => {
      await addFilter(page, "error");
      await expect(page.locator(".log-row.matched")).toHaveCount(2);
    });

    test("case-sensitive matching respects letter case", async ({ page }) => {
      await addFilter(page, "error", { caseSensitive: true });
      await expect(page.locator(".log-row.matched")).toHaveCount(0);
    });
  });

  // ---- Suite C: filter sets (tabs) ----
  test.describe("filter sets", () => {
    test("starts with one 'Filters' set and a tab count", async ({ page }) => {
      await expect(page.locator(".gtab")).toHaveCount(1);
      await expect(page.locator(".gtab.active .gtab-name")).toHaveText(
        "Filters",
      );

      await addFilter(page, "wifi");
      await addFilter(page, "ERROR");
      await expect(page.locator(".gtab.active .gtab-count")).toHaveText("2");
    });

    test("adds a new set that starts empty and active", async ({ page }) => {
      await addFilter(page, "wifi");
      await addSet(page);

      await expect(page.locator(".gtab")).toHaveCount(2);
      await expect(page.locator(".gtab.active .gtab-name")).toHaveText(
        "New set",
      );
      await expect(page.locator(".gtab.active .gtab-count")).toHaveText("0");
      await expect(page.locator(".filter-row")).toHaveCount(0);
      await expect(page.locator(".filter-empty")).toBeVisible();
    });

    test("keeps each set's filters independent", async ({ page }) => {
      await addFilter(page, "wifi");
      await addSet(page);
      await addFilter(page, "ERROR");

      await expect(filterRow(page, "ERROR")).toBeVisible();
      await expect(filterRow(page, "wifi")).toHaveCount(0);

      await setTab(page, "Filters").click();
      await expect(filterRow(page, "wifi")).toBeVisible();
      await expect(filterRow(page, "ERROR")).toHaveCount(0);
    });

    test("renames a set via its context menu", async ({ page }) => {
      await page.locator(".gtab.active").click({ button: "right" });
      await page.getByRole("menuitem", { name: "Rename set" }).click();
      await page.locator(".gtab-name-input").fill("Errors");
      await page.locator(".gtab-name-input").press("Enter");

      await expect(page.locator(".gtab.active .gtab-name")).toHaveText(
        "Errors",
      );
    });

    test("deletes an empty set without confirming", async ({ page }) => {
      await addSet(page);
      await expect(page.locator(".gtab")).toHaveCount(2);

      await setTab(page, "New set").locator(".gtab-x").click();
      await expect(page.locator(".gtab")).toHaveCount(1);
      await expect(setTab(page, "New set")).toHaveCount(0);
    });

    test("confirms before deleting a non-empty set", async ({ page }) => {
      await addFilter(page, "wifi");
      await addSet(page);

      await setTab(page, "Filters").locator(".gtab-x").click();
      await confirmDialog(page, "Delete");

      await expect(setTab(page, "Filters")).toHaveCount(0);
      await expect(page.locator(".gtab")).toHaveCount(1);
    });

    test("duplicates a set via its context menu", async ({ page }) => {
      await addFilter(page, "wifi");
      await addFilter(page, "ERROR");

      await setTab(page, "Filters").click({ button: "right" });
      await page.getByRole("menuitem", { name: "Duplicate set" }).click();

      const copy = setTab(page, "Filters copy");
      await expect(copy).toHaveClass(/active/);
      await expect(copy.locator(".gtab-count")).toHaveText("2");
      await expect(filterRow(page, "wifi")).toBeVisible();
      await expect(filterRow(page, "ERROR")).toBeVisible();
    });
  });

  // ---- Suite D: groups (each seeds a top-level filter so the group renders) ----
  test.describe("groups", () => {
    test.beforeEach(async ({ page }) => {
      await addFilter(page, "wifi");
    });

    test("adds an empty group shown with an empty hint", async ({ page }) => {
      await addGroup(page);

      await expect(section(page)).toHaveCount(1);
      await expect(section(page).locator(".fs-name")).toHaveText("New group");
      await expect(section(page).locator(".fs-count")).toHaveText("0");
      await expect(section(page).locator(".fs-empty")).toBeVisible();
    });

    test("adds a filter into a group via its + button", async ({ page }) => {
      await addGroup(page);
      await addFilterToGroup(page, "ERROR");

      await expect(section(page).locator(".fs-count")).toHaveText("1");
      await expect(
        section(page).locator(".fsection-body .filter-row"),
      ).toHaveCount(1);
      await expect(
        section(page).locator(".fsection-body .fr-pattern"),
      ).toHaveText("ERROR");
    });

    test("collapses and expands a group", async ({ page }) => {
      await addGroup(page);
      await addFilterToGroup(page, "ERROR");

      await section(page).locator(".fs-chevron").click();
      await expect(section(page).locator(".fsection-body")).toHaveCount(0);

      await section(page).locator(".fs-chevron").click();
      await expect(section(page).locator(".fsection-body")).toBeVisible();
      await expect(
        section(page).locator(".fsection-body .filter-row"),
      ).toHaveCount(1);
    });

    test("renames a group by double-clicking its name", async ({ page }) => {
      await addGroup(page);

      await section(page).locator(".fs-name").dblclick();
      await section(page).locator(".fs-name-input").fill("Radio");
      await section(page).locator(".fs-name-input").press("Enter");

      await expect(section(page).locator(".fs-name")).toHaveText("Radio");
    });

    test("enable/disable all filters in a group", async ({ page }) => {
      await addGroup(page);
      await addFilterToGroup(page, "ERROR");
      await addFilterToGroup(page, "WARN");

      await section(page)
        .getByRole("button", { name: "Group actions" })
        .click();
      await page
        .getByRole("menuitem", { name: "Disable all in group" })
        .click();
      await expect(section(page).locator(".filter-row.disabled")).toHaveCount(
        2,
      );

      await section(page)
        .getByRole("button", { name: "Group actions" })
        .click();
      await page.getByRole("menuitem", { name: "Enable all in group" }).click();
      await expect(section(page).locator(".filter-row.disabled")).toHaveCount(
        0,
      );
    });

    test("deleting a group keeps its filters", async ({ page }) => {
      await addGroup(page);
      await addFilterToGroup(page, "ERROR");

      await section(page)
        .getByRole("button", { name: "Group actions" })
        .click();
      await page
        .getByRole("menuitem", { name: "Delete group (keep filters)" })
        .click();

      await expect(section(page)).toHaveCount(0);
      await expect(filterRow(page, "wifi")).toBeVisible();
      await expect(filterRow(page, "ERROR")).toBeVisible();
      await expect(page.locator(".filter-row")).toHaveCount(2);
    });
  });

  // ---- Suite F: batch select mode ----
  test.describe("select mode", () => {
    test.beforeEach(async ({ page }) => {
      await addFilter(page, "wifi");
      await addFilter(page, "ERROR");
      await addFilter(page, "WARN");
    });

    test("Ctrl/Cmd-clicking a row enters select mode and selects it", async ({
      page,
    }) => {
      await filterRow(page, "wifi").click({ modifiers: ["ControlOrMeta"] });
      await expect(page.locator(".select-bar")).toBeVisible();
      await expect(filterRow(page, "wifi")).toHaveClass(/selected/);
    });

    test("clicking rows accumulates a selection with a count", async ({
      page,
    }) => {
      await enterSelectMode(page);

      await clickRow(page, "wifi");
      await expect(page.locator(".filter-row.selected")).toHaveCount(1);
      await clickRow(page, "ERROR");
      await expect(page.locator(".filter-row.selected")).toHaveCount(2);
      await expect(page.locator(".sb-count")).toContainText("2");
    });

    test("Shift-click selects a range", async ({ page }) => {
      await enterSelectMode(page);

      await clickRow(page, "wifi");
      await clickRow(page, "WARN", { modifiers: ["Shift"] });
      await expect(page.locator(".filter-row.selected")).toHaveCount(3);
    });

    test("the select-all checkbox toggles all and clears", async ({ page }) => {
      await enterSelectMode(page);

      await page.locator(".sb-all").click();
      await expect(page.locator(".filter-row.selected")).toHaveCount(3);
      await page.locator(".sb-all").click();
      await expect(page.locator(".filter-row.selected")).toHaveCount(0);
    });

    test("Enable / Disable act on the selection", async ({ page }) => {
      await enterSelectMode(page);
      await clickRow(page, "wifi");
      await clickRow(page, "ERROR");

      const bar = page.locator(".select-bar");
      await bar.getByRole("button", { name: "Disable" }).click();
      await expect(page.locator(".filter-row.disabled")).toHaveCount(2);

      await bar.getByRole("button", { name: "Enable" }).click();
      await expect(page.locator(".filter-row.disabled")).toHaveCount(0);
    });

    test("Delete removes the selection after confirming", async ({ page }) => {
      await enterSelectMode(page);
      await clickRow(page, "wifi");
      await clickRow(page, "ERROR");

      await page
        .locator(".select-bar")
        .getByRole("button", { name: "Delete" })
        .click();
      await confirmDialog(page, "Delete");

      await expect(page.locator(".select-bar")).toBeHidden();
      await expect(page.locator(".filter-row")).toHaveCount(1);
      await expect(filterRow(page, "WARN")).toBeVisible();
    });

    test("Esc leaves select mode without deleting", async ({ page }) => {
      await enterSelectMode(page);
      await clickRow(page, "wifi");

      await page.keyboard.press("Escape");
      await expect(page.locator(".select-bar")).toBeHidden();
      await expect(page.locator(".filter-row")).toHaveCount(3);
    });

    test("switching sets exits select mode", async ({ page }) => {
      await enterSelectMode(page);
      await addSet(page);

      await expect(page.locator(".select-bar")).toBeHidden();
    });
  });

  // ---- Suite E: search ----
  test.describe("search", () => {
    test.beforeEach(async ({ page }) => {
      await addFilter(page, "wifi");
      await addFilter(page, "ERROR", { description: "fatal errors" });
      await addFilter(page, "WARN");
    });

    test("filters the list by pattern", async ({ page }) => {
      await page.getByPlaceholder("Search filters").fill("wifi");
      await expect(page.locator(".filter-row")).toHaveCount(1);
      await expect(filterRow(page, "wifi")).toBeVisible();
    });

    test("matches on description too", async ({ page }) => {
      await page.getByPlaceholder("Search filters").fill("fatal");
      await expect(page.locator(".filter-row")).toHaveCount(1);
      await expect(filterRow(page, "fatal errors")).toBeVisible();
    });

    test("clearing the search restores the full list", async ({ page }) => {
      await page.getByPlaceholder("Search filters").fill("wifi");
      await expect(page.locator(".filter-row")).toHaveCount(1);

      await page.locator(".clear-x").click();
      await expect(page.locator(".filter-row")).toHaveCount(3);
    });

    test("searching flattens groups away", async ({ page }) => {
      await addGroup(page);
      await expect(section(page)).toHaveCount(1);

      await page.getByPlaceholder("Search filters").fill("wifi");
      // While searching the list is flat — no group headers.
      await expect(section(page)).toHaveCount(0);
      await expect(filterRow(page, "wifi")).toBeVisible();
    });
  });

  // ---- Suite G: import / export (IO boundary) ----
  test.describe("import / export", () => {
    test("Save filters as… writes the set as JSON", async ({ page, tauri }) => {
      await addFilter(page, "wifi");
      await tauri.setDialogSave("/filters/a.json");

      await panelMenu(page, "Save filters as");

      const calls = await tauri.calls();
      const write = calls.find((c) => c.cmd === "write_text_file");
      expect(write).toBeTruthy();
      const args = write!.args as { path: string; contents: string };
      expect(args.path).toBe("/filters/a.json");
      expect(args.contents).toContain("wifi");
    });

    test("round-trips: export then import into an empty set", async ({
      page,
      tauri,
    }) => {
      await addFilter(page, "wifi");
      await tauri.setDialogSave("/filters/a.json");
      await panelMenu(page, "Save filters as");
      const calls = await tauri.calls();
      const contents = (
        calls.find((c) => c.cmd === "write_text_file")!.args as {
          contents: string;
        }
      ).contents;

      // Import that file into a fresh, empty set (no replace confirmation).
      await addSet(page);
      await tauri.setFile("/filters/a.json", contents);
      await tauri.setDialogOpen("/filters/a.json");
      await panelMenu(page, "Import filters");

      await expect(filterRow(page, "wifi")).toBeVisible();
    });

    test("Append merges an imported file beside existing filters", async ({
      page,
      tauri,
    }) => {
      // Make a file to append (export a one-filter set).
      await addFilter(page, "wifi");
      await tauri.setDialogSave("/filters/a.json");
      await panelMenu(page, "Save filters as");
      const contents = (
        (await tauri.calls()).find((c) => c.cmd === "write_text_file")!
          .args as {
          contents: string;
        }
      ).contents;

      // In a fresh set with its own filter, append the file.
      await addSet(page);
      await addFilter(page, "ERROR");
      await tauri.setFile("/filters/a.json", contents);
      await tauri.setDialogOpen("/filters/a.json");
      await panelMenu(page, "Append filters");

      await expect(filterRow(page, "ERROR")).toBeVisible();
      await expect(filterRow(page, "wifi")).toBeVisible();
      await expect(page.locator(".filter-row")).toHaveCount(2);
    });

    test("Delete all filters clears the set without confirming", async ({
      page,
    }) => {
      await addFilter(page, "wifi");
      await addFilter(page, "ERROR");

      await panelMenu(page, "Delete all filters");

      await expect(page.locator(".filter-row")).toHaveCount(0);
      await expect(page.locator(".filter-empty")).toBeVisible();
    });

    test("importing a non-Logsy file surfaces an error and changes nothing", async ({
      page,
      tauri,
    }) => {
      await tauri.setFile("/filters/bad.json", "this is not a filter file");
      await tauri.setDialogOpen("/filters/bad.json");

      await panelMenu(page, "Import filters");

      await expect(page.getByText(/isn't Logsy/i)).toBeVisible();
      await expect(page.locator(".filter-row")).toHaveCount(0);
    });
  });

  // ---- Suite I: drag-and-drop reorder (dnd-kit) ----
  test.describe("reorder (drag & drop)", () => {
    test("reorders top-level filters", async ({ page }) => {
      await addFilter(page, "wifi");
      await addFilter(page, "ERROR");
      await addFilter(page, "WARN");

      await dragTo(page, filterRow(page, "wifi"), filterRow(page, "WARN"));
      await page.mouse.move(5, 5); // away from rows so no hover card lingers

      expect(await listLabels(page)).toEqual(["ERROR", "WARN", "wifi"]);
    });

    test("moves a filter into a group", async ({ page }) => {
      await addFilter(page, "keepme");
      await addFilter(page, "wifi");
      await addGroup(page);

      await dragTo(
        page,
        filterRow(page, "wifi"),
        section(page).locator(".fsection-body"),
      );
      await page.mouse.move(5, 5);

      await expect(
        section(page).locator(".fsection-body .fr-pattern"),
      ).toHaveText("wifi");
    });

    test("moves a filter out of a group", async ({ page }) => {
      await addFilter(page, "keepme");
      await addGroup(page);
      await addFilterToGroup(page, "wifi");

      await dragTo(
        page,
        section(page).locator(".fsection-body .filter-row"),
        filterRow(page, "keepme"),
      );
      await page.mouse.move(5, 5);

      await expect(
        section(page).locator(".fsection-body .fr-pattern"),
      ).toHaveCount(0);
      expect((await listLabels(page)).sort()).toEqual(["keepme", "wifi"]);
    });

    test("reorders groups", async ({ page }) => {
      await addFilter(page, "x");
      await addGroup(page);
      await addGroup(page); // "New group", "New group 1"

      const head = (name: string) =>
        page
          .locator(".fsection-head")
          .filter({ has: page.getByText(name, { exact: true }) });
      await dragTo(page, head("New group 1"), head("New group"));
      await page.mouse.move(5, 5);

      const names = await page
        .locator(".filter-list .fsection .fs-name")
        .allTextContents();
      expect(names).toEqual(["New group 1", "New group"]);
    });

    test("reorders filter sets (tabs)", async ({ page }) => {
      await addSet(page); // [Filters, New set]

      await dragTo(page, setTab(page, "Filters"), setTab(page, "New set"));

      const tabs = await page.locator(".gtab-name").allTextContents();
      expect(tabs).toEqual(["New set", "Filters"]);
    });
  });
});

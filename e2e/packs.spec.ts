import {
  test,
  expect,
  openLog,
  addFilter,
  fillNewFilter,
  filterRow,
  addSet,
  confirmDialog,
  openPacksDrawer,
  packCard,
  saveSelectionAsPack,
  type Page,
} from "./support/fixtures";

// All filter-pack e2e lives here, one describe per area (matching the panel-per-
// file convention). The pack library is app-wide state persisted off the undo
// stack; these tests drive the drawer UI and assert the store→panel wiring
// (inserted filters land as rows), not the dedupe/merge math — that's unit-tested
// in src/__tests__/packs.test.ts.

const headCount = (page: Page) => page.locator(".packs-head-count");
const insertBtn = (page: Page, pack: string) =>
  packCard(page, pack).getByRole("button", { name: "Add to filters" });

test.describe("Filter packs", () => {
  test.beforeEach(async ({ page, tauri }) => {
    await openLog(page, tauri);
  });

  // ---- Suite A: the drawer ----
  test.describe("drawer", () => {
    test("opens from the toolbar and closes from its X", async ({ page }) => {
      await openPacksDrawer(page);
      await expect(page.locator(".packs-drawer")).toBeVisible();

      await page
        .locator(".packs-drawer")
        .getByRole("button", { name: "Close" })
        .click();
      // Slide-out keeps the node briefly, then it unmounts.
      await expect(page.locator(".packs-drawer")).toBeHidden();
    });

    test("shows an empty state with no packs", async ({ page }) => {
      await openPacksDrawer(page);
      await expect(page.locator(".packs-empty")).toBeVisible();
      await expect(page.getByText("No packs yet")).toBeVisible();
      await expect(headCount(page)).toHaveText("0");
    });

    test("a brand-new empty pack appears with its insert button disabled", async ({
      page,
    }) => {
      await openPacksDrawer(page);
      await page.getByRole("button", { name: "New empty pack" }).click();

      await expect(packCard(page, "New pack")).toBeVisible();
      await expect(headCount(page)).toHaveText("1");
      // Nothing to insert yet — the button is a dead-end otherwise.
      await expect(insertBtn(page, "New pack")).toBeDisabled();
    });

    test("search filters the pack list by name", async ({ page }) => {
      await addFilter(page, "wifi");
      await addFilter(page, "ERROR");
      await saveSelectionAsPack(page, ["wifi"], "Radio pack");
      await saveSelectionAsPack(page, ["ERROR"], "Fault pack");

      await page.locator(".packs-search input").fill("Radio");
      await expect(packCard(page, "Radio pack")).toBeVisible();
      await expect(packCard(page, "Fault pack")).toHaveCount(0);
    });
  });

  // ---- Suite B: creating packs ----
  test.describe("creating", () => {
    test("saves a selection as a new pack", async ({ page }) => {
      await addFilter(page, "wifi");
      await addFilter(page, "ERROR");
      await saveSelectionAsPack(page, ["wifi", "ERROR"], "My pack");

      // Drawer auto-opens on save; the card lists both filters.
      const card = packCard(page, "My pack");
      await expect(card).toBeVisible();
      await card.locator(".pack-expand").click();
      await expect(card.locator(".pack-detail .fr-pattern-chip")).toHaveCount(
        2,
      );
    });

    test("saves an entire set as a pack via the tab menu", async ({ page }) => {
      await addFilter(page, "wifi");
      await page.locator(".gtab.active").click({ button: "right" });
      await page.getByRole("menuitem", { name: "Save set as pack" }).click();

      await openPacksDrawer(page);
      // The set is named "Filters", so the pack adopts that name.
      await expect(packCard(page, "Filters")).toBeVisible();
      await expect(headCount(page)).toHaveText("1");
    });

    test("adds a selection into an existing pack", async ({ page }) => {
      await addFilter(page, "wifi");
      await addFilter(page, "ERROR");
      await saveSelectionAsPack(page, ["wifi"], "Growing pack");

      // Re-enter select mode, pick ERROR, and add it to the existing pack.
      await page.getByRole("button", { name: "More actions" }).click();
      await page.getByRole("menuitem", { name: "Select filters" }).click();
      const row = filterRow(page, "ERROR");
      await expect(row).toBeVisible();
      await row.click({ force: true });
      await page
        .locator(".select-bar button", { hasText: "Add to pack" })
        .click();
      await page.locator(".grpc-item", { hasText: "Growing pack" }).click();

      const card = packCard(page, "Growing pack");
      await card.locator(".pack-expand").click();
      await expect(card.locator(".pack-detail .fr-pattern-chip")).toHaveCount(
        2,
      );
    });
  });

  // ---- Suite C: inserting into the active set ----
  test.describe("insert", () => {
    test("inserts a whole pack's filters into a set", async ({ page }) => {
      await addFilter(page, "wifi");
      await saveSelectionAsPack(page, ["wifi"], "Wifi");

      // Insert into a fresh, empty set — no overlap, no confirm.
      await addSet(page);
      await expect(page.locator(".filter-row")).toHaveCount(0);

      await insertBtn(page, "Wifi").click();
      await expect(filterRow(page, "wifi")).toBeVisible();
      await expect(page.locator(".filter-list .filter-row")).toHaveCount(1);
    });

    test("confirms before inserting filters already in the set", async ({
      page,
    }) => {
      await addFilter(page, "wifi");
      await saveSelectionAsPack(page, ["wifi"], "Wifi");

      // The active set still holds wifi, so inserting overlaps — Cancel keeps it
      // at one row, Insert all piles the pack in anyway.
      await insertBtn(page, "Wifi").click();
      await confirmDialog(page, "Cancel");
      await expect(page.locator(".filter-list .filter-row")).toHaveCount(1);

      await insertBtn(page, "Wifi").click();
      await confirmDialog(page, "Insert all");
      await expect(page.locator(".filter-list .filter-row")).toHaveCount(2);
    });

    test("inserts a single filter from a pack via its row menu", async ({
      page,
    }) => {
      await addFilter(page, "wifi");
      await addFilter(page, "ERROR");
      await saveSelectionAsPack(page, ["wifi", "ERROR"], "Two");

      await addSet(page); // empty target set
      const card = packCard(page, "Two");
      await card.locator(".pack-expand").click();

      // Right-click the pack's wifi row → "Add to filters".
      await card
        .locator(".pack-detail .filter-row")
        .filter({ has: page.locator(".fr-pattern-chip", { hasText: "wifi" }) })
        .click({ button: "right" });
      await page.getByRole("menuitem", { name: "Add to filters" }).click();

      // Scope to the panel's list — the expanded card also renders a `.filter-row`
      // for wifi, so a bare `filterRow` would match both.
      const panelRows = page.locator(".filter-list .filter-row");
      await expect(panelRows).toHaveCount(1);
      await expect(panelRows.locator(".fr-pattern")).toHaveText("wifi");
    });
  });

  // ---- Suite D: editing a pack in place ----
  test.describe("editing", () => {
    test("renames a pack from the ⋯ menu", async ({ page }) => {
      await addFilter(page, "wifi");
      await saveSelectionAsPack(page, ["wifi"], "Old name");

      await packCard(page, "Old name")
        .getByRole("button", { name: "Pack actions" })
        .click();
      await page.getByRole("menuitem", { name: "Rename" }).click();
      // While renaming the card's `.pack-name` is swapped for the input, so the
      // name-scoped `packCard` no longer matches — target the input page-wide.
      await page.locator(".pack-rename-input").fill("New name");
      await page.locator(".pack-rename-input").press("Enter");

      await expect(packCard(page, "New name")).toBeVisible();
      await expect(packCard(page, "Old name")).toHaveCount(0);
    });

    test("duplicates and deletes a pack", async ({ page }) => {
      await addFilter(page, "wifi");
      await saveSelectionAsPack(page, ["wifi"], "Base");

      await packCard(page, "Base")
        .getByRole("button", { name: "Pack actions" })
        .click();
      await page.getByRole("menuitem", { name: "Duplicate" }).click();
      await expect(packCard(page, "Base copy")).toBeVisible();
      await expect(headCount(page)).toHaveText("2");

      await packCard(page, "Base copy")
        .getByRole("button", { name: "Pack actions" })
        .click();
      await page.getByRole("menuitem", { name: "Delete pack" }).click();
      await confirmDialog(page, "Delete"); // "Delete pack?" confirm
      await expect(packCard(page, "Base copy")).toHaveCount(0);
      await expect(headCount(page)).toHaveText("1");
    });

    test("adding a filter to an empty pack enables its insert button", async ({
      page,
    }) => {
      await openPacksDrawer(page);
      await page.getByRole("button", { name: "New empty pack" }).click();
      const card = packCard(page, "New pack");
      await expect(insertBtn(page, "New pack")).toBeDisabled();

      await card
        .getByRole("button", { name: "New filter in this pack" })
        .click();
      await fillNewFilter(page, "boot");

      await expect(insertBtn(page, "New pack")).toBeEnabled();
    });

    test("adds a tag, surfacing the chip and the tag bar", async ({ page }) => {
      await addFilter(page, "wifi");
      await saveSelectionAsPack(page, ["wifi"], "Tagged");

      const card = packCard(page, "Tagged");
      await card.locator(".pack-expand").click();
      await card.locator(".pte-addpill").click();
      await card.locator(".pte-input").fill("network");
      await card.locator(".pte-input").press("Enter");
      await expect(
        card.locator(".pack-tags-edit .tag-chip", { hasText: "network" }),
      ).toBeVisible();

      // Collapsed, the read-only chip shows and the drawer's tag bar appears.
      await card.locator(".pack-expand").click();
      await expect(
        card.locator(".pack-tags .tag-chip", { hasText: "network" }),
      ).toBeVisible();
      await expect(page.locator(".packs-tagbar")).toBeVisible();
    });
  });

  // ---- Suite E: import / export (IO boundary) ----
  test.describe("import / export", () => {
    test("exports a pack to a JSON file", async ({ page, tauri }) => {
      await addFilter(page, "wifi");
      await saveSelectionAsPack(page, ["wifi"], "Wifi");

      await tauri.setDialogSave("/packs/wifi.json");
      await packCard(page, "Wifi")
        .getByRole("button", { name: "Pack actions" })
        .click();
      await page.getByRole("menuitem", { name: "Export to file" }).click();

      const write = (await tauri.calls()).find(
        (c) => c.cmd === "write_text_file",
      );
      expect(write).toBeTruthy();
      const args = write!.args as { path: string; contents: string };
      expect(args.path).toBe("/packs/wifi.json");
      expect(args.contents).toContain("wifi");
    });

    test("round-trips: export a pack then import it back", async ({
      page,
      tauri,
    }) => {
      await addFilter(page, "wifi");
      await saveSelectionAsPack(page, ["wifi"], "Wifi");

      // Capture what the app writes, then feed it back through import.
      await tauri.setDialogSave("/packs/wifi.json");
      await packCard(page, "Wifi")
        .getByRole("button", { name: "Pack actions" })
        .click();
      await page.getByRole("menuitem", { name: "Export to file" }).click();
      const contents = (
        (await tauri.calls()).find((c) => c.cmd === "write_text_file")!
          .args as { contents: string }
      ).contents;

      await tauri.setFile("/packs/imported.json", contents);
      await tauri.setDialogOpen("/packs/imported.json");
      await page
        .getByRole("button", { name: "Import a pack from a file" })
        .click();

      // The new pack is named after the file.
      await expect(packCard(page, "imported")).toBeVisible();
    });

    test("importing a non-Logsy file surfaces an error and adds nothing", async ({
      page,
      tauri,
    }) => {
      await openPacksDrawer(page);
      await tauri.setFile("/packs/bad.json", "this is not a filter file");
      await tauri.setDialogOpen("/packs/bad.json");

      await page
        .getByRole("button", { name: "Import a pack from a file" })
        .click();

      await expect(page.getByText(/isn't a Logsy filter pack/i)).toBeVisible();
      await expect(page.locator(".pack-card")).toHaveCount(0);
    });
  });
});

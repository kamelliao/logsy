import {
  test,
  expect,
  openLog,
  addFilter,
  logRowMenu,
  openTab,
  STRUCTURED_LOG,
  STRUCTURED_PATTERN,
  type Page,
} from "./support/fixtures";

// Add the named-group regex so the structured log's lines carry parsed fields
// (only parsed lines can be compared).
const addParseFilter = (page: Page) =>
  addFilter(page, STRUCTURED_PATTERN, { regex: true });

const groups = (page: Page) => page.locator(".cmp-group");
const rows = (page: Page) => page.locator(".cmp-vrow");

test.describe("Compare", () => {
  test.beforeEach(async ({ page, tauri }) => {
    await openLog(page, tauri, "/logs/s.log", STRUCTURED_LOG);
  });

  test("is empty until a parsed line is added", async ({ page }) => {
    await openTab(page, "Compare");
    await expect(page.getByText("Nothing to compare yet")).toBeVisible();
  });

  test("adding a parsed line builds a table with its fields", async ({
    page,
  }) => {
    await addParseFilter(page);
    await logRowMenu(page, 1, "Add to compare");
    await openTab(page, "Compare");

    await expect(groups(page)).toHaveCount(1);
    const heads = page.locator(".cmp-colhead .cmp-ch");
    await expect(heads).toContainText(["line", "t", "level", "msg"]);

    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText("INFO");
    await expect(rows(page).first()).toContainText("boot ok");
  });

  test("Import matching pulls every parsed line into the table", async ({
    page,
  }) => {
    await addParseFilter(page);
    await logRowMenu(page, 1, "Add to compare");
    await openTab(page, "Compare");

    await page
      .getByRole("button", { name: "Import this table's matching lines" })
      .click();
    // All four structured lines are parsed by the filter.
    await expect(rows(page)).toHaveCount(4);
  });

  test("clicking a line number jumps to that line in the log", async ({
    page,
  }) => {
    await addParseFilter(page);
    await logRowMenu(page, 3, "Add to compare");
    await openTab(page, "Compare");

    await page.locator(".cmp-ln-btn").click();
    const selected = page.locator(".log-row.selected");
    await expect(selected).toHaveCount(1);
    await expect(selected.locator(".log-gut")).toHaveText("3");
  });

  test("removing a row drops it from the table", async ({ page }) => {
    await addParseFilter(page);
    await logRowMenu(page, 1, "Add to compare");
    await logRowMenu(page, 2, "Add to compare");
    await openTab(page, "Compare");
    await expect(rows(page)).toHaveCount(2);

    await rows(page).first().locator(".cmp-rm-btn").click();
    await expect(rows(page)).toHaveCount(1);
  });

  test("clearing a group removes its table", async ({ page }) => {
    await addParseFilter(page);
    await logRowMenu(page, 1, "Add to compare");
    await openTab(page, "Compare");
    await expect(groups(page)).toHaveCount(1);

    await page
      .getByRole("button", { name: "Remove this table's lines" })
      .click();
    await expect(page.getByText("Nothing to compare yet")).toBeVisible();
  });

  test("a group collapses and expands", async ({ page }) => {
    await addParseFilter(page);
    await logRowMenu(page, 1, "Add to compare");
    await openTab(page, "Compare");

    await page.getByRole("button", { name: "Collapse this table" }).click();
    await expect(page.locator(".cmp-table-scroll")).toHaveCount(0);
    await page.getByRole("button", { name: "Expand this table" }).click();
    await expect(page.locator(".cmp-table-scroll")).toBeVisible();
  });

  test("exports a group as CSV", async ({ page, tauri }) => {
    await addParseFilter(page);
    await logRowMenu(page, 1, "Add to compare");
    await openTab(page, "Compare");

    await tauri.setDialogSave("/out/compare.csv");
    await page
      .getByRole("button", { name: "Export this table as CSV" })
      .click();

    const write = (await tauri.calls()).find(
      (c) => c.cmd === "write_text_file",
    );
    expect(write).toBeTruthy();
    const args = write!.args as { path: string; contents: string };
    expect(args.path).toBe("/out/compare.csv");
    expect(args.contents).toContain("level");
    expect(args.contents).toContain("INFO");
  });

  test("two filters produce one table each", async ({ page }) => {
    // Narrow filters so each parses a different subset → two distinct groups.
    await addFilter(page, "INFO (?<info>.+)", { regex: true });
    await addFilter(page, "ERROR (?<err>.+)", { regex: true });

    await logRowMenu(page, 1, "Add to compare"); // INFO line
    await logRowMenu(page, 3, "Add to compare"); // ERROR line
    await openTab(page, "Compare");

    await expect(groups(page)).toHaveCount(2);
  });

  test("removing from the log's menu updates the table", async ({ page }) => {
    await addParseFilter(page);
    await logRowMenu(page, 1, "Add to compare");
    await openTab(page, "Compare");
    await expect(rows(page)).toHaveCount(1);

    await logRowMenu(page, 1, "Remove from compare");
    await expect(page.getByText("Nothing to compare yet")).toBeVisible();
  });
});

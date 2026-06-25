import {
  test,
  expect,
  openLog,
  addFilter,
  filterRow,
  type Page,
} from "./support/fixtures";

const openMenu = (page: Page, name: string) =>
  page.locator(`.menu[data-menu="${name}"]`).click();
const menuItem = (page: Page, label: string) =>
  page.locator(".menu-pop .menu-item", { hasText: label });

test.describe("menu bar", () => {
  test.beforeEach(async ({ page, tauri }) => {
    await openLog(page, tauri);
  });

  test("opens a menu and lists its items", async ({ page }) => {
    await openMenu(page, "File");
    await expect(page.locator(".menu-pop")).toBeVisible();
    await expect(menuItem(page, "Open")).toBeVisible();
  });

  test("hovering a sibling switches the open menu", async ({ page }) => {
    await openMenu(page, "File");
    await page.locator('.menu[data-menu="Edit"]').hover();
    await expect(menuItem(page, "Undo")).toBeVisible();
  });

  test("arrow keys move between top-level menus", async ({ page }) => {
    await openMenu(page, "File");
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".menu.active")).toHaveAttribute(
      "data-menu",
      "Edit",
    );
    await page.keyboard.press("ArrowLeft");
    await expect(page.locator(".menu.active")).toHaveAttribute(
      "data-menu",
      "File",
    );
  });

  test("Escape closes the menu", async ({ page }) => {
    await openMenu(page, "File");
    await expect(page.locator(".menu-pop")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".menu-pop")).toHaveCount(0);
  });

  test("View ▸ Show line numbers toggles the gutter", async ({ page }) => {
    await expect(page.locator(".log-gut").first()).toBeVisible();

    await openMenu(page, "View");
    await menuItem(page, "Show line numbers").click();
    await expect(page.locator(".log-gut")).toHaveCount(0);

    await openMenu(page, "View");
    await menuItem(page, "Show line numbers").click();
    await expect(page.locator(".log-gut").first()).toBeVisible();
  });

  test("File ▸ Open… opens another file", async ({ page, tauri }) => {
    await tauri.setFile("/logs/two.log", "alpha\nbeta\n");
    await tauri.setDialogOpen("/logs/two.log");

    await openMenu(page, "File");
    await menuItem(page, "Open").click();

    await expect(page.locator(".file-item")).toHaveCount(2);
  });

  test("Filters ▸ Add new filter… opens the editor", async ({ page }) => {
    await openMenu(page, "Filters");
    await menuItem(page, "Add new filter").click();
    await expect(
      page.getByRole("dialog").filter({ hasText: "New filter" }),
    ).toBeVisible();
  });

  test("Filters ▸ Disable all filters disables every row", async ({ page }) => {
    await addFilter(page, "wifi");
    await addFilter(page, "ERROR");

    await openMenu(page, "Filters");
    await menuItem(page, "Disable all filters").click();
    await expect(page.locator(".filter-row.disabled")).toHaveCount(2);
  });

  test("Edit ▸ Undo is disabled until there's history, then undoes", async ({
    page,
  }) => {
    await openMenu(page, "Edit");
    await expect(menuItem(page, "Undo")).toHaveClass(/disabled/);
    await page.keyboard.press("Escape");

    await addFilter(page, "wifi");
    await openMenu(page, "Edit");
    await menuItem(page, "Undo").click();
    await expect(filterRow(page, "wifi")).toHaveCount(0);
  });

  test("Help ▸ About shows the about box", async ({ page }) => {
    await openMenu(page, "Help");
    await menuItem(page, "About").click();
    await expect(page.locator(".about-box")).toBeVisible();
    await expect(page.locator(".about-name")).toHaveText("Logsy");
  });

  test("Help ▸ Keyboard shortcuts shows the shortcuts box", async ({
    page,
  }) => {
    await openMenu(page, "Help");
    await menuItem(page, "Keyboard shortcuts").click();
    await expect(page.locator(".shortcuts-modal")).toBeVisible();
  });
});

test.describe("keyboard shortcuts", () => {
  test.beforeEach(async ({ page, tauri }) => {
    await openLog(page, tauri);
  });

  test("Ctrl+B toggles the filter panel", async ({ page }) => {
    await expect(page.locator(".filter-panel")).toBeVisible();
    await page.keyboard.press("ControlOrMeta+b");
    await expect(page.locator(".filter-panel")).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+b");
    await expect(page.locator(".filter-panel")).toBeVisible();
  });

  test("Ctrl+Shift+N opens a new filter", async ({ page }) => {
    await page.keyboard.press("ControlOrMeta+Shift+N");
    await expect(
      page.getByRole("dialog").filter({ hasText: "New filter" }),
    ).toBeVisible();
  });

  test("Ctrl+Shift+L focuses the filter search box", async ({ page }) => {
    await page.keyboard.press("ControlOrMeta+Shift+L");
    await expect(page.getByPlaceholder("Search filters")).toBeFocused();
  });
});

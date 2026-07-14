import {
  test,
  expect,
  confirmDialog,
  dragTo,
  SAMPLE_LOG,
} from "./support/fixtures";
import type { Page } from "./support/fixtures";
import type { TauriMock } from "./support/tauri-mock";

/** Open `n` logs named boot-1.log … and expand the (initially collapsed) sidebar. */
async function openMany(page: Page, tauri: TauriMock, names: string[]) {
  const paths = names.map((n) => `/logs/${n}`);
  for (const p of paths) await tauri.setFile(p, SAMPLE_LOG);
  await tauri.setDialogOpen(paths);
  await page.locator(".empty-workspace").click();
  await expect(page.locator(".file-item")).toHaveCount(names.length);
  if (await page.locator(".sidebar.collapsed").count()) {
    await page.locator(".sidebar-top button").click();
    await expect(page.locator(".sidebar.collapsed")).toHaveCount(0);
  }
}

const many = Array.from({ length: 24 }, (_, i) => `boot-${i + 1}.log`);

test.describe("sidebar", () => {
  test("a long file list scrolls instead of spilling over the actions", async ({
    page,
    tauri,
  }) => {
    await openMany(page, tauri, many);
    // The rows must stay INSIDE their drop zone. When the zone was allowed to
    // shrink (flex-shrink defaulting to 1 in the column flex list), it was squeezed
    // below its content and the rows painted on top of "New Group" / "Open File".
    const zone = await page.locator(".fg-ungrouped").boundingBox();
    const lastRow = await page.locator(".file-sortrow").last().boundingBox();
    expect(zone).not.toBeNull();
    expect(lastRow).not.toBeNull();
    expect(lastRow!.y + lastRow!.height).toBeLessThanOrEqual(
      zone!.y + zone!.height + 1,
    );

    // And the actions sit clear of the last row rather than under it.
    const openFile = await page
      .locator(".new-tab", { hasText: "Open File" })
      .boundingBox();
    expect(openFile!.y).toBeGreaterThanOrEqual(
      lastRow!.y + lastRow!.height - 1,
    );
  });

  test("Ctrl-click selects several files and the row menu closes them at once", async ({
    page,
    tauri,
  }) => {
    await openMany(page, tauri, ["boot.log", "wifi.log", "sensor.log"]);
    const row = (name: string) =>
      page.locator(".file-item").filter({ hasText: name });
    await row("boot.log").click({ modifiers: ["Control"] });
    await row("sensor.log").click({ modifiers: ["Control"] });
    await expect(page.locator(".file-item.selected")).toHaveCount(2);

    await row("boot.log").click({ button: "right" });
    await page.locator(".file-menu .menu-item", { hasText: "Close 2" }).click();
    // One confirm for the whole batch, not one per file.
    await confirmDialog(page, "Close");
    await expect(page.locator(".file-item")).toHaveCount(1);
    await expect(page.locator(".file-item .file-name")).toHaveText("wifi.log");
  });

  test("Escape or a click on the empty space drops the selection", async ({
    page,
    tauri,
  }) => {
    await openMany(page, tauri, ["boot.log", "wifi.log"]);
    const boot = page.locator(".file-item").filter({ hasText: "boot.log" });

    await boot.click({ modifiers: ["Control"] });
    await expect(page.locator(".file-item.selected")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(page.locator(".file-item.selected")).toHaveCount(0);

    await boot.click({ modifiers: ["Control"] });
    await expect(page.locator(".file-item.selected")).toHaveCount(1);
    // The empty space BELOW the last row (the ungrouped zone stretches to fill it) —
    // clicking a row would just select that row instead.
    const zone = await page.locator(".fg-ungrouped").boundingBox();
    await page
      .locator(".fg-ungrouped")
      .click({ position: { x: 10, y: zone!.height - 6 } });
    await expect(page.locator(".file-item.selected")).toHaveCount(0);
  });

  test("middle-clicking a file row closes it", async ({ page, tauri }) => {
    await openMany(page, tauri, ["boot.log", "wifi.log"]);
    await page
      .locator(".file-item")
      .filter({ hasText: "boot.log" })
      .click({ button: "middle" });
    await confirmDialog(page, "Close");
    await expect(page.locator(".file-item")).toHaveCount(1);
    await expect(page.locator(".file-item .file-name")).toHaveText("wifi.log");
  });

  test("the arrow keys walk the list, Enter opens, Shift extends", async ({
    page,
    tauri,
  }) => {
    await openMany(page, tauri, ["boot.log", "wifi.log", "sensor.log"]);
    const rows = page.locator(".file-item");
    // A click puts the keyboard on the row it hit; the arrows take it from there.
    await rows.first().click();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect(rows.nth(2)).toBeFocused();

    await page.keyboard.press("Enter");
    await expect(page.locator(".file-item.active .file-name")).toHaveText(
      "sensor.log",
    );

    // Shift+Arrow grows the selection from the row Enter just opened.
    await page.keyboard.press("Shift+ArrowUp");
    await expect(page.locator(".file-item.selected")).toHaveCount(2);

    // Delete closes the whole selection behind one confirm.
    await page.keyboard.press("Delete");
    await confirmDialog(page, "Close");
    await expect(rows).toHaveCount(1);
    await expect(rows.locator(".file-name")).toHaveText("boot.log");
  });

  test("a group header expands and collapses from the keyboard", async ({
    page,
    tauri,
  }) => {
    await openMany(page, tauri, ["boot.log", "wifi.log"]);
    // Put boot.log in a group of its own via its row menu.
    const boot = page.locator(".file-item").filter({ hasText: "boot.log" });
    await boot.click({ button: "right" });
    await page
      .locator(".file-menu .menu-item", { hasText: "New group" })
      .click();
    const header = page.locator(".fg-header");
    await page.locator(".fg-name-input").press("Enter");
    await expect(page.locator(".file-group .file-item")).toHaveCount(1);

    await header.click(); // focuses the header (and toggles it shut)
    await expect(page.locator(".file-group .file-item")).toHaveCount(0);
    await page.keyboard.press("ArrowRight"); // → opens a collapsed group
    await expect(page.locator(".file-group .file-item")).toHaveCount(1);
    await page.keyboard.press("ArrowRight"); // → again steps onto its first file
    await expect(page.locator(".file-group .file-item").first()).toBeFocused();
    await page.keyboard.press("ArrowLeft"); // ← back up to the header
    await expect(header).toBeFocused();
    await page.keyboard.press("ArrowLeft"); // ← collapses it
    await expect(page.locator(".file-group .file-item")).toHaveCount(0);
  });

  test("a group's options open from a right-click on its header", async ({
    page,
    tauri,
  }) => {
    await openMany(page, tauri, ["boot.log", "wifi.log"]);
    await page
      .locator(".file-item")
      .filter({ hasText: "boot.log" })
      .click({ button: "right" });
    await page
      .locator(".file-menu .menu-item", { hasText: "New group" })
      .click();
    await page.locator(".fg-name-input").press("Enter");

    // The kebab is hover-only; a right-click anywhere on the header opens the same menu.
    await page.locator(".fg-header").click({ button: "right" });
    const menu = page.locator(".fg-menu");
    await expect(menu).toBeVisible();
    await menu.getByText("Ungroup (keep files)").click();
    await expect(page.locator(".file-group")).toHaveCount(0);
    await expect(page.locator(".file-item")).toHaveCount(2); // files survive
  });

  test("a file can be dropped into a collapsed group", async ({
    page,
    tauri,
  }) => {
    await openMany(page, tauri, ["boot.log", "wifi.log"]);
    const row = (name: string) =>
      page.locator(".file-item").filter({ hasText: name });
    await row("boot.log").click({ button: "right" });
    await page
      .locator(".file-menu .menu-item", { hasText: "New group" })
      .click();
    await page.locator(".fg-name-input").press("Enter");

    const header = page.locator(".fg-header");
    await header.locator(".fg-chevron").click(); // fold it shut
    await expect(page.locator(".file-group .file-item")).toHaveCount(0);

    // With no body to aim at, the header itself takes the drop.
    await dragTo(page, row("wifi.log"), header);
    await expect(page.locator(".fg-count")).toHaveText("2");
    await expect(page.locator(".fg-ungrouped .file-item")).toHaveCount(0);
    // Still collapsed — the file was filed away, not opened up.
    await expect(page.locator(".file-group .file-item")).toHaveCount(0);
  });

  test("dragging one row of a selection carries the whole selection", async ({
    page,
    tauri,
  }) => {
    await openMany(page, tauri, ["boot.log", "wifi.log", "sensor.log"]);
    const row = (name: string) =>
      page.locator(".file-item").filter({ hasText: name });
    await page.keyboard.press("Control+\\"); // two panes, both on sensor.log
    await expect(page.locator(".pane-group")).toHaveCount(2);

    await row("boot.log").click({ modifiers: ["Control"] });
    await row("wifi.log").click({ modifiers: ["Control"] });
    // Grabbing boot.log drags wifi.log along — the pane gets both, not just the row
    // under the cursor.
    await dragTo(page, row("boot.log"), page.locator(".pane-group").nth(1));
    const tabs = page.locator(".pane-group").nth(1).locator(".pane-tab");
    await expect(tabs).toHaveCount(3); // sensor.log was already there
    await expect(tabs.filter({ hasText: "boot.log" })).toBeVisible();
    await expect(tabs.filter({ hasText: "wifi.log" })).toBeVisible();
  });

  test("a row's context menu moves the whole selection to a group", async ({
    page,
    tauri,
  }) => {
    await openMany(page, tauri, ["boot.log", "wifi.log", "sensor.log"]);
    const row = (name: string) =>
      page.locator(".file-item").filter({ hasText: name });
    await row("boot.log").click({ modifiers: ["Control"] });
    await row("sensor.log").click({ modifiers: ["Control"] });

    await row("boot.log").click({ button: "right" });
    const menu = page.locator(".file-menu");
    await expect(
      menu.locator(".menu-section", { hasText: "Move 2 files to group" }),
    ).toBeVisible();
    await menu.getByText("New group with 2 files…").click();

    // Both selected files land in the new group; the unselected one stays put.
    const group = page.locator(".file-group").first();
    await expect(group.locator(".file-item")).toHaveCount(2);
    await expect(group.locator(".file-name")).toHaveText([
      "boot.log",
      "sensor.log",
    ]);
    await expect(page.locator(".fg-ungrouped .file-item")).toHaveCount(1);
  });

  test("Quick Open jumps to a log by a fuzzy name match", async ({
    page,
    tauri,
  }) => {
    await openMany(page, tauri, ["boot.log", "wifi-scan.log", "sensor.log"]);
    await page.keyboard.press("Control+p");
    const input = page.locator(".qo-input");
    await expect(input).toBeFocused();
    await input.fill("wsc"); // subsequence of wifi-SCan → wifi-scan.log
    await expect(page.locator(".qo-row").first()).toContainText(
      "wifi-scan.log",
    );
    await input.press("Enter");
    await expect(page.locator(".qo-overlay")).toHaveCount(0);
    await expect(page.locator(".file-item.active .file-name")).toHaveText(
      "wifi-scan.log",
    );
  });

  test("a split marks every log a pane is showing", async ({ page, tauri }) => {
    await openMany(page, tauri, ["boot.log", "wifi.log"]);
    // The last log opened (wifi.log) is the active one, so after the split BOTH panes
    // show it — one marked row. Dragging boot.log onto the second pane gives the two
    // panes different logs, and both rows must then be marked.
    await page.keyboard.press("Control+\\");
    await expect(page.locator(".pane-group")).toHaveCount(2);
    await expect(page.locator(".file-item.in-pane")).toHaveCount(1);

    await dragTo(
      page,
      page.locator(".file-item").filter({ hasText: "boot.log" }),
      page.locator(".pane-group").nth(1),
    );
    await expect(page.locator(".file-item.in-pane")).toHaveCount(2);
  });
});

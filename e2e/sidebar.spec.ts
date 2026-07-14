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

  test("the filter box narrows the list, Esc restores it", async ({
    page,
    tauri,
  }) => {
    await openMany(page, tauri, ["boot.log", "wifi.log", "sensor.log"]);
    const box = page.locator(".ff-input");
    await box.fill("wifi");
    await expect(page.locator(".file-item")).toHaveCount(1);
    await expect(page.locator(".file-item .file-name")).toHaveText("wifi.log");
    await box.press("Escape");
    await expect(page.locator(".file-item")).toHaveCount(3);
  });

  test("Ctrl-click selects several files and the bar closes them at once", async ({
    page,
    tauri,
  }) => {
    await openMany(page, tauri, ["boot.log", "wifi.log", "sensor.log"]);
    const row = (name: string) =>
      page.locator(".file-item").filter({ hasText: name });
    await row("boot.log").click({ modifiers: ["Control"] });
    await row("sensor.log").click({ modifiers: ["Control"] });
    await expect(page.locator(".file-selbar .fs-count")).toHaveText(
      "2 selected",
    );

    await page.locator(".file-selbar .fs-btn", { hasText: "Close" }).click();
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
    await expect(page.locator(".file-selbar")).toHaveCount(0);

    await boot.click({ modifiers: ["Control"] });
    await expect(page.locator(".file-item.selected")).toHaveCount(1);
    // The empty drop zone below the last row.
    await page.locator(".fg-ungrouped").click({ position: { x: 10, y: 10 } });
    await expect(page.locator(".file-item.selected")).toHaveCount(0);
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

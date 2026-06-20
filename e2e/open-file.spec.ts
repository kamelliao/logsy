import { test, expect, openLog, SAMPLE_LOG } from "./support/fixtures";

test.describe("opening logs", () => {
  test("opens a file via the dialog and renders its lines", async ({
    page,
    tauri,
  }) => {
    await openLog(page, tauri);

    // All 8 sample lines render (they fit in one viewport, so none are
    // virtualized away).
    await expect(page.locator(".log-row")).toHaveCount(8);
    await expect(page.locator(".log-txt").first()).toContainText(
      "boot: starting up",
    );
    // Line-number gutter is 1-based.
    await expect(page.locator(".log-gut").first()).toHaveText("1");
    await expect(page.locator(".log-gut").last()).toHaveText("8");
  });

  test("opens multiple files as switchable sidebar tabs", async ({
    page,
    tauri,
  }) => {
    await tauri.setFile("/logs/a.log", SAMPLE_LOG);
    await tauri.setFile("/logs/b.log", "only one line\n");
    await tauri.setDialogOpen(["/logs/a.log", "/logs/b.log"]);
    await page.locator(".empty-workspace").click();

    const tabs = page.locator(".file-item");
    await expect(tabs).toHaveCount(2);
    // The last-opened file is active and shown.
    await expect(page.locator(".file-item.active .file-name")).toHaveText(
      "b.log",
    );
    await expect(page.locator(".log-row")).toHaveCount(1);

    // Switch back to the first file.
    await tabs.filter({ hasText: "a.log" }).click();
    await expect(page.locator(".file-item.active .file-name")).toHaveText(
      "a.log",
    );
    await expect(page.locator(".log-row")).toHaveCount(8);
  });

  test("opens a file dropped onto the window", async ({ page, tauri }) => {
    await tauri.setFile("/logs/dropped.log", SAMPLE_LOG);
    // No log open yet → a drop loads it directly (no replace confirmation).
    await tauri.drop(["/logs/dropped.log"]);

    await expect(page.locator(".file-item.active .file-name")).toHaveText(
      "dropped.log",
    );
    await expect(page.locator(".log-row")).toHaveCount(8);
  });
});

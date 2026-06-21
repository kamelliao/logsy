import {
  test,
  expect,
  openLog,
  addFilter,
  type Page,
} from "./support/fixtures";

const fontVar = (page: Page) =>
  page.evaluate(() =>
    parseFloat(
      getComputedStyle(document.querySelector(".app")!).getPropertyValue(
        "--log-font-size",
      ),
    ),
  );

test.describe("LogView", () => {
  test.beforeEach(async ({ page, tauri }) => {
    await openLog(page, tauri);
  });

  // ---- find in view (Ctrl+F) ----
  test.describe("find", () => {
    test("Ctrl+F opens the find bar; Esc closes it", async ({ page }) => {
      await page.keyboard.press("ControlOrMeta+f");
      await expect(page.locator(".findbar")).toBeVisible();

      await page.getByPlaceholder("Find in view").fill("wifi");
      await page.keyboard.press("Escape");
      await expect(page.locator(".findbar")).toBeHidden();
    });

    test("highlights hits and counts them", async ({ page }) => {
      await page.keyboard.press("ControlOrMeta+f");
      await page.getByPlaceholder("Find in view").fill("wifi");

      // "wifi" is on lines 2 and 5 → two hits, first is current.
      await expect(page.locator(".find-count")).toHaveText("1 / 2");
      await expect(page.locator(".find-hit")).toHaveCount(2);
      await expect(page.locator(".find-hit.current")).toHaveCount(1);
    });

    test("Enter advances to the next hit (and wraps)", async ({ page }) => {
      await page.keyboard.press("ControlOrMeta+f");
      const input = page.getByPlaceholder("Find in view");
      await input.fill("wifi");
      await expect(page.locator(".find-count")).toHaveText("1 / 2");

      await input.press("Enter");
      await expect(page.locator(".find-count")).toHaveText("2 / 2");
      await input.press("Enter");
      await expect(page.locator(".find-count")).toHaveText("1 / 2");
    });

    test("shows 0 / 0 when nothing matches", async ({ page }) => {
      await page.keyboard.press("ControlOrMeta+f");
      await page.getByPlaceholder("Find in view").fill("nope-no-match");

      await expect(page.locator(".find-count")).toHaveText("0 / 0");
      await expect(page.locator(".find-hit")).toHaveCount(0);
    });

    test("the case and regex option buttons re-run the search", async ({
      page,
    }) => {
      await page.keyboard.press("ControlOrMeta+f");
      const input = page.getByPlaceholder("Find in view");

      // Case: lowercase "error" matches the uppercase ERROR lines until Aa is on.
      await input.fill("error");
      await expect(page.locator(".find-count")).toHaveText("1 / 2");
      await page.locator(".find-opt", { hasText: "Aa" }).click();
      await expect(page.locator(".find-count")).toHaveText("0 / 0");
      await page.locator(".find-opt", { hasText: "Aa" }).click();

      // Regex: the pipe is literal until .* is on, then it alternates.
      await input.fill("ERROR|WARN");
      await expect(page.locator(".find-count")).toHaveText("0 / 0");
      await page.locator(".find-opt", { hasText: ".*" }).click();
      await expect(page.locator(".find-count")).toHaveText("1 / 3");
    });
  });

  // ---- matches-only (Ctrl+H) ----
  test.describe("matches-only", () => {
    test("the toggle is disabled until there are highlights", async ({
      page,
    }) => {
      await expect(
        page.locator(".lv-actions .lv-toggle").first(),
      ).toBeDisabled();
      await addFilter(page, "wifi");
      await expect(
        page.locator(".lv-actions .lv-toggle").first(),
      ).toBeEnabled();
    });

    test("Ctrl+H shows only matched lines and back", async ({ page }) => {
      await addFilter(page, "wifi");
      await expect(page.locator(".log-row")).toHaveCount(8);

      await page.keyboard.press("ControlOrMeta+h");
      await expect(page.locator(".log-row")).toHaveCount(2);
      await expect(page.locator(".log-row.matched")).toHaveCount(2);

      await page.keyboard.press("ControlOrMeta+h");
      await expect(page.locator(".log-row")).toHaveCount(8);
    });

    test("the toolbar button toggles matches-only too", async ({ page }) => {
      await addFilter(page, "wifi");
      const btn = page.locator(".lv-actions .lv-toggle").first();

      await btn.click();
      await expect(btn).toHaveClass(/active/);
      await expect(page.locator(".log-row")).toHaveCount(2);
    });
  });

  // ---- match map ----
  test("the match map appears only when there are highlights", async ({
    page,
  }) => {
    await expect(page.locator(".match-map")).toHaveCount(0);
    await addFilter(page, "wifi");
    await expect(page.locator(".match-map")).toBeVisible();
  });

  // ---- export filtered view ----
  test("exports the currently-visible lines via the save dialog", async ({
    page,
    tauri,
  }) => {
    await addFilter(page, "wifi");
    await page.keyboard.press("ControlOrMeta+h"); // matches-only → just the 2 wifi lines
    await expect(page.locator(".log-row")).toHaveCount(2);

    await tauri.setDialogSave("/out/view.filtered.log");
    await page.locator(".lv-actions .dock-btn:not(.lv-toggle)").click();

    const write = (await tauri.calls()).find(
      (c) => c.cmd === "write_text_file",
    );
    expect(write).toBeTruthy();
    const args = write!.args as { path: string; contents: string };
    expect(args.path).toBe("/out/view.filtered.log");
    // Only the two matched lines are written, not the dimmed ones.
    expect(args.contents.split("\n")).toHaveLength(2);
    expect(args.contents).toContain("wifi: scanning networks");
    expect(args.contents).toContain("wifi: connected");
    expect(args.contents).not.toContain("boot: starting up");
  });

  // ---- go to line (Ctrl+G) ----
  test.describe("go to line", () => {
    test("Ctrl+G jumps to and selects the line", async ({ page }) => {
      await page.keyboard.press("ControlOrMeta+g");
      await expect(page.locator(".goto-box")).toBeVisible();

      await page.locator(".goto-input").fill("5");
      await page.getByRole("button", { name: "Go" }).click();

      await expect(page.locator(".goto-box")).toBeHidden();
      const selected = page.locator(".log-row.selected");
      await expect(selected).toHaveCount(1);
      await expect(selected.locator(".log-gut")).toHaveText("5");
      await expect(selected.locator(".log-txt")).toContainText(
        "wifi: connected",
      );
    });

    test("Esc cancels without selecting", async ({ page }) => {
      await page.keyboard.press("ControlOrMeta+g");
      await page.locator(".goto-input").fill("3");
      await page.keyboard.press("Escape");

      await expect(page.locator(".goto-box")).toBeHidden();
      await expect(page.locator(".log-row.selected")).toHaveCount(0);
    });
  });

  // ---- zoom ----
  test("zoom in / out / reset change the log font size", async ({ page }) => {
    const base = await fontVar(page);

    await page.keyboard.press("ControlOrMeta+=");
    expect(await fontVar(page)).toBeGreaterThan(base);

    await page.keyboard.press("ControlOrMeta+0");
    expect(await fontVar(page)).toBe(base);

    await page.keyboard.press("ControlOrMeta+-");
    expect(await fontVar(page)).toBeLessThan(base);
  });
});

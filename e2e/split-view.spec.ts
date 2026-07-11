import {
  test,
  expect,
  dragTo,
  addFilter,
  filterRow,
  SAMPLE_LOG,
  type Page,
} from "./support/fixtures";
import type { TauriMock } from "./support/tauri-mock";

// The split view (#6→#5): VS Code-style editor groups. Two panes, each with its
// own file tab strip; the focused pane drives the active file (and panels); files
// can be dragged between panes and dropped from the OS onto a specific pane. These
// drive the mocked frontend (no real Tauri), matching the rest of the e2e suite.

async function openTwo(page: Page, tauri: TauriMock) {
  await tauri.setFile("/logs/a.log", SAMPLE_LOG);
  await tauri.setFile("/logs/b.log", "beta one\nbeta two\nbeta three\n");
  await tauri.setDialogOpen(["/logs/a.log", "/logs/b.log"]);
  await page.locator(".empty-workspace").click();
  await expect(page.locator(".file-item")).toHaveCount(2);
}

async function split(page: Page) {
  await page.getByRole("button", { name: "Split view" }).click();
  await expect(page.locator(".pane-group")).toHaveCount(2);
}

const pane = (page: Page, id: "a" | "b") =>
  page.locator(`.pane-group[data-pane="${id}"]`);

async function expandSidebar(page: Page) {
  if (await page.locator(".sidebar.collapsed").count())
    await page.locator(".sidebar-top button").click();
  await expect(page.locator(".sidebar.collapsed")).toHaveCount(0);
}

test.describe("split view", () => {
  test("splits into two panes, each showing a different file tab", async ({
    page,
    tauri,
  }) => {
    await openTwo(page, tauri);
    await split(page);

    await expect(page.locator(".pane-tabs")).toHaveCount(2);
    const nameA = await pane(page, "a")
      .locator(".pane-tab.active .pane-tab-name")
      .textContent();
    const nameB = await pane(page, "b")
      .locator(".pane-tab.active .pane-tab-name")
      .textContent();
    expect(nameA).not.toEqual(nameB);
    expect([nameA, nameB].sort()).toEqual(["a.log", "b.log"]);
  });

  test("clicking the other pane focuses it without a reload overlay", async ({
    page,
    tauri,
  }) => {
    await openTwo(page, tauri);
    await split(page);

    // Pane A is focused on split; clicking into pane B moves focus there.
    await expect(pane(page, "a")).toHaveClass(/focused/);
    await pane(page, "b").locator(".lv-stat").click();
    await expect(pane(page, "b")).toHaveClass(/focused/);
    await expect(pane(page, "a")).not.toHaveClass(/focused/);
    // The key fix: swapping focus between already-loaded panes must NOT flash the
    // file-switch / loading overlay.
    await expect(page.locator(".busy-overlay")).toHaveCount(0);
  });

  test("side-by-side panes share the global filter set", async ({
    page,
    tauri,
  }) => {
    await openTwo(page, tauri);
    await split(page);
    // Filter sets are global now: both files show the SAME single set (no per-file
    // sets, no share badge), so a filter added applies across both panes.
    await expect(page.locator(".gtab")).toHaveCount(1);
    await expect(page.locator(".gtab-shared")).toHaveCount(0);
  });

  test("a filter added while comparing applies to both files", async ({
    page,
    tauri,
  }) => {
    await tauri.setFile("/logs/a.log", "boot ok\nERROR sensor\nready\n");
    await tauri.setFile("/logs/b.log", "start\nERROR i2c\ndone\n");
    await tauri.setDialogOpen(["/logs/a.log", "/logs/b.log"]);
    await page.locator(".empty-workspace").click();
    await expect(page.locator(".file-item")).toHaveCount(2);
    await split(page);

    await addFilter(page, "ERROR");
    await expect(filterRow(page, "ERROR")).toBeVisible();

    // Focusing the other pane keeps showing the SAME filter — both files use the
    // global set (the filter genuinely crosses files, not just the focused one).
    await pane(page, "b").locator(".lv-stat").click();
    await expect(pane(page, "b")).toHaveClass(/focused/);
    await expect(filterRow(page, "ERROR")).toBeVisible();
  });

  // Regression (#3): with the old shared-set model an auto-share effect forced both
  // panes onto the non-empty set, so a freshly added EMPTY set could never become
  // active in split view. Global sets have no such effect — the empty set opens.
  test("a new empty filter set can be opened in split view", async ({
    page,
    tauri,
  }) => {
    await openTwo(page, tauri);
    await split(page);
    await addFilter(page, "ERROR");
    await expect(filterRow(page, "ERROR")).toBeVisible();

    // Add a new (empty) set — it must become the active tab and show no filters.
    await page.locator(".gtab-add").click();
    await expect(page.locator(".gtab.active .gtab-count")).toHaveText("0");
    await expect(filterRow(page, "ERROR")).toHaveCount(0);
  });

  // The active filter set is per-DOCUMENT: two panes showing different files apply
  // different sets (the set LIST is global, but each doc remembers its own choice).
  test("two panes with different files apply different filter sets", async ({
    page,
    tauri,
  }) => {
    await openTwo(page, tauri);
    await split(page);

    // Both files open on the one global set, so this filter shows for both.
    await addFilter(page, "shared");
    await expect(filterRow(page, "shared")).toBeVisible();

    // Give the focused pane's file (a.log) its OWN new set + a distinct filter.
    await page.locator(".gtab-add").click();
    await addFilter(page, "onlyA");
    await expect(filterRow(page, "onlyA")).toBeVisible();
    await expect(filterRow(page, "shared")).toHaveCount(0);

    // Focus the other pane (b.log): it still uses the ORIGINAL set → shows "shared",
    // not a.log's "onlyA". The two documents apply different sets side by side.
    await pane(page, "b").locator(".lv-stat").click();
    await expect(pane(page, "b")).toHaveClass(/focused/);
    await expect(filterRow(page, "shared")).toBeVisible();
    await expect(filterRow(page, "onlyA")).toHaveCount(0);
  });

  test("an OS file drop opens in the pane under the cursor", async ({
    page,
    tauri,
  }) => {
    await openTwo(page, tauri);
    await split(page);
    await tauri.setFile("/logs/c.log", "gamma one\ngamma two\n");

    const box = await pane(page, "b").boundingBox();
    if (!box) throw new Error("pane B not visible");
    await tauri.drop(["/logs/c.log"], {
      x: box.x + box.width / 2,
      y: box.y + box.height / 2,
    });

    await expect(
      pane(page, "b").locator(".pane-tab-name", { hasText: "c.log" }),
    ).toBeVisible();
    await expect(page.locator(".file-item")).toHaveCount(3);
  });

  test("dragging a tab moves the file to the other pane", async ({
    page,
    tauri,
  }) => {
    await openTwo(page, tauri);
    await split(page);
    // Give pane B a second tab (drop a file into it), then drag that tab to pane A.
    await tauri.setFile("/logs/c.log", "gamma\n");
    const box = await pane(page, "b").boundingBox();
    if (!box) throw new Error("pane B not visible");
    await tauri.drop(["/logs/c.log"], {
      x: box.x + box.width / 2,
      y: box.y + box.height / 2,
    });
    await expect(pane(page, "b").locator(".pane-tab")).toHaveCount(2);

    const tabC = pane(page, "b").locator(".pane-tab", { hasText: "c.log" });
    await dragTo(page, tabC, pane(page, "a").locator(".pane-tabs"));

    await expect(
      pane(page, "a").locator(".pane-tab", { hasText: "c.log" }),
    ).toBeVisible();
    await expect(
      pane(page, "b").locator(".pane-tab", { hasText: "c.log" }),
    ).toHaveCount(0);
  });

  test("dragging a tab within a pane reorders it", async ({ page, tauri }) => {
    await openTwo(page, tauri);
    await split(page);
    // Pane B starts with a.log; drop c.log into it so it has two tabs [a.log, c.log].
    await tauri.setFile("/logs/c.log", "gamma\n");
    const box = await pane(page, "b").boundingBox();
    if (!box) throw new Error("pane B not visible");
    await tauri.drop(["/logs/c.log"], {
      x: box.x + box.width / 2,
      y: box.y + box.height / 2,
    });
    await expect(pane(page, "b").locator(".pane-tab")).toHaveCount(2);
    await expect(pane(page, "b").locator(".pane-tab-name").first()).toHaveText(
      "a.log",
    );

    // Drag the first tab (a.log) to the end of the strip → it lands after c.log.
    await dragTo(
      page,
      pane(page, "b").locator(".pane-tab").first(),
      pane(page, "b").locator(".pane-tabs-rest"),
    );
    await expect(pane(page, "b").locator(".pane-tab-name").first()).toHaveText(
      "c.log",
    );
  });

  test("dropping an already-open file adds it to the pane without duplicating", async ({
    page,
    tauri,
  }) => {
    await openTwo(page, tauri);
    await split(page);
    // Pane B shows a.log; drop a.log (already open) onto pane A.
    const box = await pane(page, "a").boundingBox();
    if (!box) throw new Error("pane A not visible");
    await tauri.drop(["/logs/a.log"], {
      x: box.x + box.width / 2,
      y: box.y + box.height / 2,
    });

    // No duplicate file entry (still two files in the sidebar)…
    await expect(page.locator(".file-item")).toHaveCount(2);
    // …but a.log now appears as a tab in pane A too (same doc, second group).
    await expect(
      pane(page, "a").locator(".pane-tab", { hasText: "a.log" }),
    ).toBeVisible();
  });

  test("a sidebar file can be dragged onto the right pane", async ({
    page,
    tauri,
  }) => {
    await openTwo(page, tauri);
    await split(page); // pane A = b.log, pane B = a.log
    await expandSidebar(page);
    // b.log lives in pane A; drag it from the sidebar onto the RIGHT pane (B).
    const bRow = page.locator(".file-item").filter({ hasText: "b.log" });
    await dragTo(page, bRow, pane(page, "b"));
    await expect(
      pane(page, "b").locator(".pane-tab", { hasText: "b.log" }),
    ).toBeVisible();
  });

  test("dragging a sidebar file over a pane shows its drop indicator", async ({
    page,
    tauri,
  }) => {
    await openTwo(page, tauri);
    await split(page);
    await expandSidebar(page);
    const s = await page
      .locator(".file-item")
      .filter({ hasText: "b.log" })
      .boundingBox();
    const t = await pane(page, "b").boundingBox();
    if (!s || !t) throw new Error("row/pane not visible");
    // Manual drag (no release) so we can assert the indicator mid-drag.
    await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2);
    await page.mouse.down();
    await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2 + 8, {
      steps: 5,
    });
    await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2, { steps: 16 });
    await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2 + 1, {
      steps: 3,
    });
    await expect(pane(page, "b").locator(".pane-drop-hint")).toBeVisible();
    await page.mouse.up();
  });

  test("dragging a sidebar file to the log's right edge opens a split", async ({
    page,
    tauri,
  }) => {
    await openTwo(page, tauri); // single pane shows b.log
    await expandSidebar(page);
    await expect(page.locator(".pane-group")).toHaveCount(0);

    const s = await page
      .locator(".file-item")
      .filter({ hasText: "a.log" })
      .boundingBox();
    const lv = await page.locator(".logview").boundingBox();
    if (!s || !lv) throw new Error("row/logview not visible");
    const tx = lv.x + lv.width * 0.85; // right-edge band
    const ty = lv.y + lv.height * 0.5;
    await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2);
    await page.mouse.down();
    await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2 + 8, {
      steps: 5,
    });
    await page.mouse.move(tx, ty, { steps: 16 });
    await page.mouse.move(tx, ty + 1, { steps: 3 });
    await expect(page.locator(".lv-split-preview.right")).toBeVisible();
    await page.mouse.up();

    await expect(page.locator(".pane-group")).toHaveCount(2);
    await expect(
      pane(page, "b").locator(".pane-tab", { hasText: "a.log" }),
    ).toBeVisible();
  });

  test("dragging a sidebar file to the left edge splits with it on the left", async ({
    page,
    tauri,
  }) => {
    await openTwo(page, tauri); // single pane shows b.log (active)
    await expandSidebar(page);
    const s = await page
      .locator(".file-item")
      .filter({ hasText: "a.log" })
      .boundingBox();
    const lv = await page.locator(".logview").boundingBox();
    if (!s || !lv) throw new Error("row/logview not visible");
    const tx = lv.x + lv.width * 0.1; // left-edge band
    const ty = lv.y + lv.height * 0.5;
    await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2);
    await page.mouse.down();
    await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2 + 8, {
      steps: 5,
    });
    await page.mouse.move(tx, ty, { steps: 16 });
    await page.mouse.move(tx, ty + 1, { steps: 3 });
    await expect(page.locator(".lv-split-preview.left")).toBeVisible();
    await page.mouse.up();

    await expect(page.locator(".pane-group")).toHaveCount(2);
    // a.log is on the LEFT (pane A), the previously-active b.log on the right (B).
    await expect(
      pane(page, "a").locator(".pane-tab", { hasText: "a.log" }),
    ).toBeVisible();
    await expect(
      pane(page, "b").locator(".pane-tab", { hasText: "b.log" }),
    ).toBeVisible();
  });

  test("dragging a sidebar file to the center opens it in place (no split)", async ({
    page,
    tauri,
  }) => {
    await openTwo(page, tauri); // active b.log
    await expandSidebar(page);
    const s = await page
      .locator(".file-item")
      .filter({ hasText: "a.log" })
      .boundingBox();
    const lv = await page.locator(".logview").boundingBox();
    if (!s || !lv) throw new Error("row/logview not visible");
    await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2);
    await page.mouse.down();
    await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2 + 8, {
      steps: 5,
    });
    await page.mouse.move(lv.x + lv.width * 0.5, lv.y + lv.height * 0.5, {
      steps: 16,
    });
    await page.mouse.move(lv.x + lv.width * 0.5 + 1, lv.y + lv.height * 0.5, {
      steps: 3,
    });
    await expect(page.locator(".lv-split-preview.center")).toBeVisible();
    await page.mouse.up();

    await expect(page.locator(".pane-group")).toHaveCount(0); // no split
    await expect(page.locator(".lv-title")).toContainText("a.log"); // opened in place
  });

  test("an OS file dropped on the log's bottom edge opens a split", async ({
    page,
    tauri,
  }) => {
    await openTwo(page, tauri); // single pane
    await tauri.setFile("/logs/c.log", "gamma\n");
    const lv = await page.locator(".logview").boundingBox();
    if (!lv) throw new Error("logview not visible");
    await tauri.drop(["/logs/c.log"], {
      x: lv.x + lv.width * 0.5,
      y: lv.y + lv.height * 0.85, // bottom-edge band
    });
    await expect(page.locator(".pane-group")).toHaveCount(2);
    await expect(page.locator(".file-item")).toHaveCount(3);
    await expect(
      pane(page, "b").locator(".pane-tab", { hasText: "c.log" }),
    ).toBeVisible();
  });

  test("the tab strip persists in single view after closing a split", async ({
    page,
    tauri,
  }) => {
    await openTwo(page, tauri);
    await split(page); // A = [b.log], B = [a.log]
    await expandSidebar(page);
    // Give the main group (pane A) a second tab, then close the split.
    const aRow = page.locator(".file-item").filter({ hasText: "a.log" });
    await dragTo(page, aRow, pane(page, "a"));
    await expect(pane(page, "a").locator(".pane-tab")).toHaveCount(2);

    await page.getByRole("button", { name: "Close split pane" }).click();
    await expect(page.locator(".pane-group")).toHaveCount(0); // single view

    // The main-group tab strip (2 tabs) survives into the single view.
    await expect(page.locator(".pane-tabs")).toHaveCount(1);
    await expect(page.locator(".pane-tabs .pane-tab")).toHaveCount(2);
  });

  test("closing the second pane returns to a single view", async ({
    page,
    tauri,
  }) => {
    await openTwo(page, tauri);
    await split(page);
    await page.getByRole("button", { name: "Close split pane" }).click();
    await expect(page.locator(".pane-group")).toHaveCount(0);
    await expect(page.locator(".logview")).toHaveCount(1);
  });

  test("closing a pane's last tab collapses that pane", async ({
    page,
    tauri,
  }) => {
    await openTwo(page, tauri);
    await split(page);
    // Pane A shows b.log (the last-opened, active file); close its only tab.
    await pane(page, "a").locator(".pane-tab .pane-tab-x").first().click();
    await expect(page.locator(".pane-group")).toHaveCount(0);
    await expect(page.locator(".logview")).toHaveCount(1);
    // The surviving single view is the other pane's file (a.log).
    await expect(page.locator(".lv-title")).toContainText("a.log");
  });
});

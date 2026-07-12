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

// The split view: VS Code-style editor groups. N panes in one row/column, each with
// its own file tab strip; the focused pane drives the active file (and the panels);
// files can be dragged between panes and dropped from the OS onto a specific pane.
// The layout persists (doc.splitView), so it survives a reload. These drive the
// mocked frontend (no real Tauri), matching the rest of the e2e suite.
//
// Panes have generated ids, so they're addressed by POSITION (left→right / top→
// bottom), which is also how a user thinks about them.

async function openTwo(page: Page, tauri: TauriMock) {
  await tauri.setFile("/logs/a.log", SAMPLE_LOG);
  await tauri.setFile("/logs/b.log", "beta one\nbeta two\nbeta three\n");
  await tauri.setDialogOpen(["/logs/a.log", "/logs/b.log"]);
  await page.locator(".empty-workspace").click();
  await expect(page.locator(".file-item")).toHaveCount(2);
}

const panes = (page: Page) => page.locator(".pane-group");
const pane = (page: Page, i: number) => panes(page).nth(i);

/** Split the focused pane. Like VS Code, the new pane opens on the SAME document. */
async function split(page: Page, expected = 2) {
  await page
    .locator(".pane-group, .lv-pane")
    .first()
    .getByRole("button", { name: "Split view" })
    .click();
  await expect(panes(page)).toHaveCount(expected);
}

/** Drop an (already-known) log onto a pane by position, making it that pane's tab. */
async function dropOnPane(
  page: Page,
  tauri: TauriMock,
  i: number,
  path: string,
) {
  const box = await pane(page, i).boundingBox();
  if (!box) throw new Error(`pane ${i} not visible`);
  await tauri.drop([path], {
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
  });
}

/** Two panes showing DIFFERENT logs: split (both on b.log), then put a.log right. */
async function splitTwoFiles(page: Page, tauri: TauriMock) {
  await split(page);
  await dropOnPane(page, tauri, 1, "/logs/a.log");
  await expect(
    pane(page, 1).locator(".pane-tab.active", { hasText: "a.log" }),
  ).toBeVisible();
}

async function expandSidebar(page: Page) {
  if (await page.locator(".sidebar.collapsed").count())
    await page.locator(".sidebar-top button").click();
  await expect(page.locator(".sidebar.collapsed")).toHaveCount(0);
}

test.describe("split view", () => {
  test("splitting opens a second pane on the same log", async ({
    page,
    tauri,
  }) => {
    await openTwo(page, tauri);
    await split(page);

    await expect(page.locator(".pane-tabs")).toHaveCount(2);
    // VS Code's "split editor": the new pane shows the document you were on.
    const names = await page.locator(".pane-tab.active .pane-tab-name").all();
    const texts = await Promise.all(names.map((n) => n.textContent()));
    expect(texts).toEqual(["b.log", "b.log"]);
  });

  test("splitting again opens a third and fourth pane", async ({
    page,
    tauri,
  }) => {
    await openTwo(page, tauri);
    await split(page, 2);
    await page.keyboard.press("Control+\\");
    await expect(panes(page)).toHaveCount(3);
    await page.keyboard.press("Control+\\");
    await expect(panes(page)).toHaveCount(4);
    // Every pane gets its own tab strip and its own log view.
    await expect(page.locator(".pane-tabs")).toHaveCount(4);
    await expect(page.locator(".logview")).toHaveCount(4);
  });

  test("Ctrl+Shift+\\ closes the focused pane", async ({ page, tauri }) => {
    await openTwo(page, tauri);
    await split(page, 2);
    await page.keyboard.press("Control+\\");
    await expect(panes(page)).toHaveCount(3);

    await page.keyboard.press("Control+Shift+\\");
    await expect(panes(page)).toHaveCount(2);
    await page.keyboard.press("Control+Shift+\\");
    await expect(panes(page)).toHaveCount(0); // back to the single view
    await expect(page.locator(".logview")).toHaveCount(1);
  });

  test("the pane layout survives a reload", async ({ page, tauri }) => {
    await openTwo(page, tauri);
    await splitTwoFiles(page, tauri); // pane 0 = b.log, pane 1 = [b.log, a.log]
    await page.keyboard.press("Control+\\");
    await expect(panes(page)).toHaveCount(3);

    const before = await panes(page).evaluateAll((els) =>
      els.map((e) =>
        [...e.querySelectorAll(".pane-tab-name")].map((t) => t.textContent),
      ),
    );
    await page.waitForTimeout(450); // the doc write is debounced 300ms

    await page.reload();
    await expect(panes(page)).toHaveCount(3);
    const after = await panes(page).evaluateAll((els) =>
      els.map((e) =>
        [...e.querySelectorAll(".pane-tab-name")].map((t) => t.textContent),
      ),
    );
    expect(after).toEqual(before);
  });

  // Regression: the split layout persists, so a restored pane can show a log that
  // was never the ACTIVE file. Nothing else reads that file, so without an explicit
  // per-pane load it comes back blank ("no lines match the active filters").
  test("a restored pane reloads its log's contents from disk", async ({
    page,
    tauri,
  }) => {
    await openTwo(page, tauri);
    await splitTwoFiles(page, tauri);
    await page.waitForTimeout(450);

    await page.reload();
    await expect(panes(page)).toHaveCount(2);
    // Both panes show real content — neither is an empty log.
    await expect(pane(page, 0).locator(".log-row").first()).toBeVisible();
    await expect(pane(page, 1).locator(".log-row").first()).toBeVisible();
    await expect(pane(page, 1).locator(".lv-stat")).not.toContainText("0 / 0");
  });

  test("same-named logs from different folders get a dir suffix on their tabs", async ({
    page,
    tauri,
  }) => {
    await tauri.setFile("/logs/deviceA/console.log", "A one\nA two\n");
    await tauri.setFile("/logs/deviceB/console.log", "B one\nB two\n");
    await tauri.setDialogOpen([
      "/logs/deviceA/console.log",
      "/logs/deviceB/console.log",
    ]);
    await page.locator(".empty-workspace").click();
    await expect(page.locator(".file-item")).toHaveCount(2);

    await split(page);
    await dropOnPane(page, tauri, 0, "/logs/deviceA/console.log");
    await dropOnPane(page, tauri, 1, "/logs/deviceB/console.log");

    // Every tab on screen is a "console.log", so every one must carry a suffix —
    // otherwise the strips would be indistinguishable.
    const names = await page.locator(".pane-tab-name").allTextContents();
    expect(new Set(names)).toEqual(new Set(["console.log"]));
    await expect(page.locator(".pane-tab-dir")).toHaveCount(names.length);
    // …and the suffixes are the two parent dirs that tell the logs apart.
    const dirs = await page.locator(".pane-tab-dir").allTextContents();
    expect([...new Set(dirs)].sort()).toEqual(["deviceA", "deviceB"]);
  });

  test("clicking another pane focuses it without a reload overlay", async ({
    page,
    tauri,
  }) => {
    await openTwo(page, tauri);
    await splitTwoFiles(page, tauri);

    // The pane just dropped into (1) has focus; clicking into pane 0 moves it.
    await expect(pane(page, 1)).toHaveClass(/focused/);
    await pane(page, 0).locator(".lv-stat").click();
    await expect(pane(page, 0)).toHaveClass(/focused/);
    await expect(pane(page, 1)).not.toHaveClass(/focused/);
    // The key fix: swapping focus between already-loaded panes must NOT flash the
    // file-switch / loading overlay.
    await expect(page.locator(".busy-overlay")).toHaveCount(0);
  });

  test("side-by-side panes share the global filter set", async ({
    page,
    tauri,
  }) => {
    await openTwo(page, tauri);
    await splitTwoFiles(page, tauri);
    // Filter sets are global: both files show the SAME single set (no per-file
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
    await splitTwoFiles(page, tauri);

    await addFilter(page, "ERROR");
    await expect(filterRow(page, "ERROR")).toBeVisible();

    // Focusing the other pane keeps showing the SAME filter — both files use the
    // global set (the filter genuinely crosses files, not just the focused one).
    await pane(page, 0).locator(".lv-stat").click();
    await expect(pane(page, 0)).toHaveClass(/focused/);
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
    await splitTwoFiles(page, tauri);
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
    await splitTwoFiles(page, tauri); // focused pane 1 = a.log, pane 0 = b.log

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
    await pane(page, 0).locator(".lv-stat").click();
    await expect(pane(page, 0)).toHaveClass(/focused/);
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
    await dropOnPane(page, tauri, 1, "/logs/c.log");

    await expect(
      pane(page, 1).locator(".pane-tab-name", { hasText: "c.log" }),
    ).toBeVisible();
    await expect(page.locator(".file-item")).toHaveCount(3);
  });

  test("dragging a tab moves the file to another pane", async ({
    page,
    tauri,
  }) => {
    await openTwo(page, tauri);
    await split(page);
    // Give pane 1 a second tab (drop a file into it), then drag that tab to pane 0.
    await tauri.setFile("/logs/c.log", "gamma\n");
    await dropOnPane(page, tauri, 1, "/logs/c.log");
    await expect(pane(page, 1).locator(".pane-tab")).toHaveCount(2);

    const tabC = pane(page, 1).locator(".pane-tab", { hasText: "c.log" });
    await dragTo(page, tabC, pane(page, 0).locator(".pane-tabs"));

    await expect(
      pane(page, 0).locator(".pane-tab", { hasText: "c.log" }),
    ).toBeVisible();
    await expect(
      pane(page, 1).locator(".pane-tab", { hasText: "c.log" }),
    ).toHaveCount(0);
  });

  test("a tab dragged across three panes lands in the far one", async ({
    page,
    tauri,
  }) => {
    await openTwo(page, tauri);
    await split(page, 2);
    await page.keyboard.press("Control+\\");
    await expect(panes(page)).toHaveCount(3);
    // Drop c.log into the FIRST pane, then drag it all the way to the third.
    await tauri.setFile("/logs/c.log", "gamma\n");
    await dropOnPane(page, tauri, 0, "/logs/c.log");
    await expect(pane(page, 0).locator(".pane-tab")).toHaveCount(2);

    await dragTo(
      page,
      pane(page, 0).locator(".pane-tab", { hasText: "c.log" }),
      pane(page, 2).locator(".pane-tabs"),
    );
    await expect(
      pane(page, 2).locator(".pane-tab", { hasText: "c.log" }),
    ).toBeVisible();
    await expect(
      pane(page, 0).locator(".pane-tab", { hasText: "c.log" }),
    ).toHaveCount(0);
    await expect(panes(page)).toHaveCount(3); // no pane collapsed
  });

  test("dragging a tab within a pane reorders it", async ({ page, tauri }) => {
    await openTwo(page, tauri);
    await split(page);
    // Pane 1 starts with b.log; drop c.log into it so it has two tabs.
    await tauri.setFile("/logs/c.log", "gamma\n");
    await dropOnPane(page, tauri, 1, "/logs/c.log");
    await expect(pane(page, 1).locator(".pane-tab")).toHaveCount(2);
    await expect(pane(page, 1).locator(".pane-tab-name").first()).toHaveText(
      "b.log",
    );

    // Drag the first tab (b.log) to the end of the strip → it lands after c.log.
    await dragTo(
      page,
      pane(page, 1).locator(".pane-tab").first(),
      pane(page, 1).locator(".pane-tabs-rest"),
    );
    await expect(pane(page, 1).locator(".pane-tab-name").first()).toHaveText(
      "c.log",
    );
  });

  test("dropping an already-open file adds it to the pane without duplicating", async ({
    page,
    tauri,
  }) => {
    await openTwo(page, tauri);
    await split(page); // both panes show b.log
    await dropOnPane(page, tauri, 0, "/logs/a.log");

    // No duplicate file entry (still two files in the sidebar)…
    await expect(page.locator(".file-item")).toHaveCount(2);
    // …but a.log now appears as a tab in pane 0 too (same doc, second group).
    await expect(
      pane(page, 0).locator(".pane-tab", { hasText: "a.log" }),
    ).toBeVisible();
  });

  test("a sidebar file can be dragged onto a pane", async ({ page, tauri }) => {
    await openTwo(page, tauri);
    await split(page);
    await expandSidebar(page);
    const aRow = page.locator(".file-item").filter({ hasText: "a.log" });
    await dragTo(page, aRow, pane(page, 1));
    await expect(
      pane(page, 1).locator(".pane-tab", { hasText: "a.log" }),
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
      .filter({ hasText: "a.log" })
      .boundingBox();
    const t = await pane(page, 1).boundingBox();
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
    await expect(pane(page, 1).locator(".pane-drop-hint")).toBeVisible();
    await page.mouse.up();
  });

  test("dragging a sidebar file to the log's right edge opens a pane there", async ({
    page,
    tauri,
  }) => {
    await openTwo(page, tauri); // single pane shows b.log
    await expandSidebar(page);
    await expect(panes(page)).toHaveCount(0);

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

    await expect(panes(page)).toHaveCount(2);
    await expect(
      pane(page, 1).locator(".pane-tab", { hasText: "a.log" }),
    ).toBeVisible();
  });

  test("dragging a sidebar file to the left edge opens the pane on the left", async ({
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

    await expect(panes(page)).toHaveCount(2);
    // a.log is on the LEFT, the previously-active b.log on the right.
    await expect(
      pane(page, 0).locator(".pane-tab", { hasText: "a.log" }),
    ).toBeVisible();
    await expect(
      pane(page, 1).locator(".pane-tab", { hasText: "b.log" }),
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

    await expect(panes(page)).toHaveCount(0); // no split
    await expect(page.locator(".lv-title")).toContainText("a.log"); // opened in place
  });

  test("an OS file dropped on the log's bottom edge opens a pane below", async ({
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
    await expect(panes(page)).toHaveCount(2);
    await expect(page.locator(".file-item")).toHaveCount(3);
    await expect(
      pane(page, 1).locator(".pane-tab", { hasText: "c.log" }),
    ).toBeVisible();
  });

  test("the tab strip persists in single view after closing a pane", async ({
    page,
    tauri,
  }) => {
    await openTwo(page, tauri);
    await split(page); // both panes show b.log
    await expandSidebar(page);
    // Give the first pane a second tab, then close the second pane.
    const aRow = page.locator(".file-item").filter({ hasText: "a.log" });
    await dragTo(page, aRow, pane(page, 0));
    await expect(pane(page, 0).locator(".pane-tab")).toHaveCount(2);

    await pane(page, 1).getByRole("button", { name: "Close pane" }).click();
    await expect(panes(page)).toHaveCount(0); // single view

    // The surviving pane's tab strip (2 tabs) carries into the single view.
    await expect(page.locator(".pane-tabs")).toHaveCount(1);
    await expect(page.locator(".pane-tabs .pane-tab")).toHaveCount(2);
  });

  test("closing the second pane returns to a single view", async ({
    page,
    tauri,
  }) => {
    await openTwo(page, tauri);
    await split(page);
    await pane(page, 1).getByRole("button", { name: "Close pane" }).click();
    await expect(panes(page)).toHaveCount(0);
    await expect(page.locator(".logview")).toHaveCount(1);
  });

  test("closing a pane's last tab collapses that pane", async ({
    page,
    tauri,
  }) => {
    await openTwo(page, tauri);
    await splitTwoFiles(page, tauri); // pane 0 = b.log, pane 1 = [b.log, a.log]
    // Close pane 0's only tab → the pane goes with it.
    await pane(page, 0).locator(".pane-tab .pane-tab-x").first().click();
    await expect(panes(page)).toHaveCount(0);
    await expect(page.locator(".logview")).toHaveCount(1);
  });
});

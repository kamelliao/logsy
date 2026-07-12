import {
  test,
  expect,
  openLog,
  logRow,
  logRowMenu,
  type Page,
} from "./support/fixtures";

// Notebook panel: creation, slash menu, block drag (pointer-based — HTML5 DnD
// is dead inside Tauri's dragDropEnabled webview), the Notion-style title, and
// the two structural guarantees of the store split: switching notebooks must
// not remount the log view, and app undo must never touch notebook content.

async function openNotebook(page: Page) {
  await page.locator(".ptab", { hasText: "Notebook" }).click();
  const newBtn = page.getByRole("button", { name: "New notebook" });
  try {
    await newBtn.waitFor({ state: "visible", timeout: 2000 });
    await newBtn.click();
  } catch {
    /* a notebook already exists */
  }
  await expect(page.locator(".nb-prosemirror .ProseMirror")).toBeVisible();
}

test.describe("Notebook", () => {
  test.beforeEach(async ({ page, tauri }) => {
    await openLog(page, tauri);
    await openNotebook(page);
  });

  test("slash menu inserts a heading", async ({ page }) => {
    const pm = page.locator(".nb-prosemirror .ProseMirror");
    await pm.click();
    await page.keyboard.type("/");
    await expect(page.locator(".nb-slash-menu")).toBeVisible();
    await page.keyboard.type("hea");
    await page.keyboard.press("Enter"); // Heading 1 is the first match
    await expect(page.locator(".nb-slash-menu")).toBeHidden();
    await page.keyboard.type("Report");
    await expect(pm.locator("h1")).toHaveText("Report");
  });

  test("slash menu filters and Escape cancels", async ({ page }) => {
    await page.locator(".nb-prosemirror .ProseMirror").click();
    await page.keyboard.type("/quo");
    await expect(page.locator(".nb-slash-item")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(page.locator(".nb-slash-menu")).toBeHidden();
  });

  test("drag handle reorders blocks via pointer drag", async ({ page }) => {
    const pm = page.locator(".nb-prosemirror .ProseMirror");
    await pm.click();
    await page.keyboard.type("alpha");
    await page.keyboard.press("Enter");
    await page.keyboard.type("beta");
    await page.keyboard.press("Enter");
    await page.keyboard.type("gamma");

    await pm.locator("p", { hasText: "alpha" }).hover();
    const grip = page.locator(".nb-drag-grip");
    await expect(grip).toBeVisible();

    // Drop "alpha" onto gamma's lower half → beta, gamma, alpha.
    const g = await grip.boundingBox();
    const t = await pm.locator("p", { hasText: "gamma" }).boundingBox();
    if (!g || !t) throw new Error("boxes not found");
    await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
    await page.mouse.down();
    await page.mouse.move(t.x + 40, t.y + t.height * 0.8, { steps: 12 });
    await expect(page.locator(".nb-drop-indicator")).toBeVisible();
    await page.mouse.up();

    const texts = await pm.locator("p").allInnerTexts();
    expect(texts[0]).toBe("beta");
    expect(texts.at(-1)).toBe("alpha");
  });

  test("title header is bound to the notebook name", async ({ page }) => {
    const title = page.locator(".nb-title");
    await expect(title).toHaveValue("Untitled");
    await title.click();
    await title.fill("Crash triage");
    await expect(page.locator("[data-slot='select-trigger']")).toContainText(
      "Crash triage",
    );
    // Enter drops the caret into the document (wait for focus to land before
    // typing — the editor grabs it asynchronously).
    await page.keyboard.press("Enter");
    await expect(page.locator(".nb-prosemirror .ProseMirror")).toBeFocused();
    await page.keyboard.type("body text");
    await expect(page.locator(".nb-prosemirror .ProseMirror")).toContainText(
      "body text",
    );
  });

  test("ArrowLeft escapes a code block from its top-left corner", async ({
    page,
  }) => {
    const pm = page.locator(".nb-prosemirror .ProseMirror");
    await pm.click();
    // Code block as the FIRST node.
    await page.getByRole("button", { name: "Code block" }).click();
    await page.keyboard.type("code");
    // Walk the caret to the block start, then one more ArrowLeft escapes by
    // creating a paragraph above (nothing exists before the block). The pauses
    // let ProseMirror sync its selection between presses — the escape handler
    // reads the PM state, which trails the DOM caret under machine-gun input.
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press("ArrowLeft");
      await page.waitForTimeout(50);
    }
    await page.keyboard.type("escaped");
    await expect(pm.locator("> *").first()).toHaveText("escaped");
    await expect(pm.locator("pre")).toContainText("code");
  });

  test("switching notebooks keeps the log view mounted", async ({ page }) => {
    await page.locator(".nb-prosemirror .ProseMirror").click();
    await page.keyboard.type("first notebook");

    // Tag the live log DOM; a remount (the old flash) would shed the tag.
    await page.evaluate(() => {
      const el = document.querySelector(".log-view, .logview, .log-rows");
      if (el) (el as HTMLElement).dataset.mountProbe = "alive";
    });

    await page.locator(".nb-bar-actions button[title='New notebook']").click();
    await page.locator(".nb-prosemirror .ProseMirror").click();
    await page.keyboard.type("second notebook");
    // Switch back via the shadcn select.
    await page.locator("[data-slot='select-trigger']").click();
    await page.locator("[data-slot='select-item']").first().click();
    await expect(page.locator(".nb-prosemirror .ProseMirror")).toContainText(
      "first notebook",
    );

    const probed = await page.evaluate(
      () =>
        (
          document.querySelector(
            ".log-view, .logview, .log-rows",
          ) as HTMLElement | null
        )?.dataset.mountProbe,
    );
    expect(probed, "log view was remounted by the notebook switch").toBe(
      "alive",
    );
  });

  test("app undo does not touch notebook content", async ({ page }) => {
    await page.locator(".nb-prosemirror .ProseMirror").click();
    await page.keyboard.type("keep me");
    // Let the 400ms autosave land, leave the editor, then hit the app's undo.
    await page.waitForTimeout(600);
    await page.locator("body").click({ position: { x: 5, y: 200 } });
    await page.keyboard.press("Control+z");
    await page.locator(".ptab", { hasText: "Notebook" }).click();
    await expect(page.locator(".nb-prosemirror .ProseMirror")).toContainText(
      "keep me",
    );
  });
});

// A pinned line's NUMBER is a link: clicking it focuses the source log (switching
// files first when the card cites a different one) and jumps to that line. The
// number stays a plain `<span>` — an EXPORTED notebook must render it as inert
// text, so no anchor/handler/pointer-cursor may leak into `renderHTML`.
test.describe("Notebook — pinned line numbers link to the log", () => {
  // Long enough that a jump has to actually scroll.
  const LONG = Array.from(
    { length: 400 },
    (_, i) => `line ${i + 1} payload`,
  ).join("\n");

  const scrollTop = (page: Page) =>
    page
      .locator(".log-scroll")
      .first()
      .evaluate((e) => e.scrollTop);

  test("clicking a line number scrolls the log to that line", async ({
    page,
    tauri,
  }) => {
    await openLog(page, tauri, "/logs/big.log", LONG);
    await logRowMenu(page, 3, /Add to notebook/);
    await expect(page.locator(".pl-card")).toBeVisible();

    // Scroll far away, so landing back on line 3 is unambiguous.
    await page
      .locator(".log-scroll")
      .first()
      .evaluate((e) => {
        e.scrollTop = 6000;
      });
    await expect.poll(() => scrollTop(page)).toBeGreaterThan(1000);

    await page.locator(".pl-card .pl-num").first().click();
    await expect.poll(() => scrollTop(page)).toBe(0); // line 3 sits at the top
    await expect(logRow(page, 3)).toHaveClass(/selected|current|active/);
  });

  test("clicking a line number switches to the card's source log first", async ({
    page,
    tauri,
  }) => {
    await tauri.setFile("/logs/big.log", LONG);
    await tauri.setFile("/logs/other.log", "other one\nother two\n");
    await tauri.setDialogOpen(["/logs/big.log", "/logs/other.log"]);
    await page.locator(".empty-workspace").click();
    await expect(page.locator(".file-item")).toHaveCount(2);
    if (await page.locator(".sidebar.collapsed").count())
      await page.locator(".sidebar-top button").click();

    const fileRow = (name: string) =>
      page.locator(".file-item").filter({ hasText: name });

    // Pin a line from big.log…
    await fileRow("big.log").click();
    await expect(page.locator(".lv-title")).toContainText("big.log");
    await logRowMenu(page, 5, /Add to notebook/);
    await expect(page.locator(".pl-card")).toBeVisible();

    // …then switch away, so the card now cites a log the view isn't showing.
    await fileRow("other.log").click();
    await expect(page.locator(".lv-title")).toContainText("other.log");

    await page.locator(".pl-card .pl-num").first().click();
    // The click pulls the source log back into view and lands on its line 5.
    await expect(page.locator(".lv-title")).toContainText("big.log");
    await expect(logRow(page, 5)).toHaveClass(/selected|current|active/);
  });

  test("an exported notebook keeps the line numbers as plain text", async ({
    page,
    tauri,
  }) => {
    await openLog(page, tauri, "/logs/big.log", LONG);
    await logRowMenu(page, 3, /Add to notebook/);
    await expect(page.locator(".pl-card")).toBeVisible();
    // The editor shows the affordance…
    await expect(page.locator(".pl-card .pl-num").first()).toHaveCSS(
      "cursor",
      "pointer",
    );

    await tauri.setDialogSave("/out/report.html");
    await page.getByRole("button", { name: /Export as HTML/i }).click();
    const write = (await tauri.calls())
      .filter((c) => c.cmd === "write_text_file")
      .pop();
    const html = String((write?.args as { contents?: string })?.contents ?? "");

    // …but the export is inert: the number is a bare span, with nothing that
    // would make it look or behave like a link in a browser.
    expect(html).toContain('<span class="pl-num">3</span>');
    expect(html).not.toMatch(/<a\s[^>]*href/i);
    expect(html).not.toMatch(/onclick/i);
    expect(html).not.toMatch(/cursor:\s*pointer/i);
  });
});

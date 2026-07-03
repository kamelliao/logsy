import { test, expect, openLog, type Page } from "./support/fixtures";

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

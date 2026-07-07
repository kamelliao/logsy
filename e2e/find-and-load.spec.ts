import { test, expect, openLog, logRow } from "./support/fixtures";

// Find-bar behavior across files and the non-blocking file-load path:
//  - the view re-centers on a hit only on explicit triggers (query change,
//    next/prev), never because the selection or the visible rows changed;
//  - next/prev restart from the selected line; Ctrl+F seeds from highlighted
//    text; each file keeps its own query;
//  - a slow disk read leaves the app usable and doesn't steal the active file;
//  - the encoding pill's Auto-detect row keeps naming the detected encoding.

const LONG_LOG = Array.from({ length: 500 }, (_, i) =>
  i === 4 || i === 249 || i === 489
    ? `[${i}] needle here`
    : `[${i}] line filler`,
).join("\n");

async function openSecondLog(
  page: import("./support/fixtures").Page,
  tauri: import("./support/tauri-mock").TauriMock,
  path: string,
  contents: string,
) {
  await tauri.setFile(path, contents);
  await tauri.setDialogOpen(path);
  await page.locator(".new-tab", { hasText: "Open File" }).click();
  await page.locator(".empty-workspace").click();
}

test("clicking a line does not re-center on the current find hit", async ({
  page,
  tauri,
}) => {
  await openLog(page, tauri, "/logs/long.log", LONG_LOG);
  await page.keyboard.press("ControlOrMeta+f");
  await page.locator(".findbar input").fill("needle");
  await expect(page.locator(".find-count")).toHaveText("1 / 3");
  await page.keyboard.press("Enter"); // → 2/3 (line 250)
  await page.keyboard.press("Enter"); // → 3/3, jumps to line 490
  await expect(page.locator(".find-count")).toHaveText("3 / 3");
  await expect(logRow(page, 490)).toBeVisible();
  // Scroll the current hit far off-screen, then click a visible line.
  await page.locator(".log-scroll").evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect(logRow(page, 12)).toBeVisible();
  await logRow(page, 12).click();
  await page.waitForTimeout(400);
  const st = await page.locator(".log-scroll").evaluate((el) => el.scrollTop);
  expect(st).toBeLessThan(100); // must NOT have been yanked back to line 490
});

test("each file preserves its own find query across switches", async ({
  page,
  tauri,
}) => {
  await openLog(page, tauri); // sample.log
  await openSecondLog(page, tauri, "/logs/b.log", "hello wifi\nplain line");
  await expect(page.locator(".file-item", { hasText: "b.log" })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+f");
  await page.locator(".findbar input").fill("wifi");
  await expect(page.locator(".find-count")).toHaveText("1 / 1");
  // sample.log starts with its own (empty) query, not b.log's.
  await page.locator(".file-item", { hasText: "sample.log" }).click();
  await page.keyboard.press("ControlOrMeta+f");
  await expect(page.locator(".findbar input")).toHaveValue("");
  await page.locator(".findbar input").fill("boot");
  await expect(page.locator(".find-count")).toHaveText("1 / 1");
  // Each file's query is restored when switching back to it.
  await page.locator(".file-item", { hasText: "b.log" }).click();
  await expect(page.locator(".findbar input")).toHaveValue("wifi");
  await page.locator(".file-item", { hasText: "sample.log" }).click();
  await expect(page.locator(".findbar input")).toHaveValue("boot");
});

test("next/prev restart from the selected line", async ({ page, tauri }) => {
  await openLog(page, tauri, "/logs/long.log", LONG_LOG);
  await page.keyboard.press("ControlOrMeta+f");
  await page.locator(".findbar input").fill("needle");
  await expect(page.locator(".find-count")).toHaveText("1 / 3"); // at line 5
  const prevBtn = page.locator(".find-nav button").nth(0);
  const nextBtn = page.locator(".find-nav button").nth(1);
  // Select a line between hit 1 (line 5) and hit 2 (line 250)…
  await logRow(page, 12).click();
  // …then next should find the first hit BELOW line 12: line 250 (2 / 3).
  await nextBtn.click();
  await expect(page.locator(".find-count")).toHaveText("2 / 3");
  await expect(logRow(page, 250)).toBeVisible();
  // Without touching the selection, next advances normally: 3 / 3.
  await nextBtn.click();
  await expect(page.locator(".find-count")).toHaveText("3 / 3");
  // A fresh selection on line 490 (just before hit 3's line): prev finds the
  // hit above it — line 250, i.e. 2 / 3.
  await logRow(page, 490).click();
  await prevBtn.click();
  await expect(page.locator(".find-count")).toHaveText("2 / 3");
});

test("Ctrl+F seeds the query from highlighted text without jumping", async ({
  page,
  tauri,
}) => {
  await openLog(page, tauri, "/logs/long.log", LONG_LOG);
  // Scroll to the middle of the file first, so an unwanted jump (to hit 1 on
  // line 1) would be visible as a scroll back to the top.
  await page.locator(".log-scroll").evaluate((el) => {
    el.scrollTop = 5000;
  });
  // Wait for the virtualizer to render the scrolled-to window: selecting a
  // stale pre-scroll row's text node loses the selection when that row is
  // replaced (the flake this guards against). The exact landing row depends on
  // the row height, so just wait for any row past line 200 to be rendered…
  await page.waitForFunction(() => {
    const gut = document.querySelector(".log-row .log-gut");
    return !!gut && parseInt(gut.textContent || "0", 10) > 200;
  });
  // …then, atomically, highlight "filler" in one of the now-rendered rows.
  await page.evaluate(() => {
    for (const row of document.querySelectorAll(".log-row")) {
      const n = parseInt(row.querySelector(".log-gut")?.textContent ?? "0", 10);
      if (n <= 200) continue;
      const el = row.querySelector(".log-txt");
      const at = (el?.textContent ?? "").indexOf("filler");
      if (!el?.firstChild || at < 0) continue;
      const r = document.createRange();
      r.setStart(el.firstChild, at);
      r.setEnd(el.firstChild, at + "filler".length);
      const s = window.getSelection()!;
      s.removeAllRanges();
      s.addRange(r);
      return;
    }
    throw new Error("no scrolled-to filler row rendered");
  });
  await page.keyboard.press("ControlOrMeta+f");
  await expect(page.locator(".findbar input")).toHaveValue("filler");
  await expect(page.locator(".find-count")).toContainText("/ 497");
  // Seeding must not scroll away from where the text was selected.
  await page.waitForTimeout(300);
  const st = await page.locator(".log-scroll").evaluate((el) => el.scrollTop);
  expect(st).toBeGreaterThan(3000);
});

test("the Auto-detect row keeps naming the detected encoding", async ({
  page,
  tauri,
}) => {
  // Make the mock honour a forced encoding label like the Rust side does.
  await page.evaluate(() => {
    const internals = (
      window as unknown as {
        __TAURI_INTERNALS__: {
          invoke: (cmd: string, args?: unknown) => Promise<unknown>;
        };
      }
    ).__TAURI_INTERNALS__;
    const orig = internals.invoke.bind(internals);
    internals.invoke = async (cmd, args) => {
      const res = (await orig(cmd, args)) as { encoding?: string } | null;
      const forced = (args as { encoding?: string })?.encoding;
      if (cmd === "read_text_file" && res && forced) res.encoding = forced;
      return res;
    };
  });
  await openLog(page, tauri); // detected as UTF-8 by the mock
  await page.locator(".enc-badge-btn").click();
  const autoRow = page.locator(".enc-item", { hasText: "Auto-detect" });
  await expect(autoRow.locator(".cc-item-hex")).toHaveText("utf-8");
  // Force Big5, reopen the popup: the trigger shows big5, Auto-detect keeps utf-8.
  await page.locator(".enc-item", { hasText: "Traditional Chinese" }).click();
  await expect(page.locator(".enc-badge-btn")).toHaveText("big5");
  await page.locator(".enc-badge-btn").click();
  await expect(autoRow.locator(".cc-item-hex")).toHaveText("utf-8");
});

test("a slow read keeps the UI usable and does not steal the active file", async ({
  page,
  tauri,
}) => {
  await openLog(page, tauri); // sample.log
  // Delay only c.log's read so we can interact mid-load.
  await page.evaluate(() => {
    const internals = (
      window as unknown as {
        __TAURI_INTERNALS__: {
          invoke: (cmd: string, args?: unknown) => Promise<unknown>;
        };
      }
    ).__TAURI_INTERNALS__;
    const orig = internals.invoke.bind(internals);
    internals.invoke = async (cmd, args) => {
      if (
        cmd === "read_text_file" &&
        (args as { path?: string })?.path === "/logs/c.log"
      )
        await new Promise((r) => setTimeout(r, 1500));
      return orig(cmd, args);
    };
  });
  await openSecondLog(page, tauri, "/logs/c.log", "c1\nc2");
  // The passive indicator shows, but the app stays clickable.
  await expect(page.locator(".busy-overlay.passive")).toBeVisible();
  await page.locator(".file-item", { hasText: "sample.log" }).click();
  await expect(logRow(page, 1)).toContainText("boot: starting up");
  // When the read lands, c.log appears but must not yank the user to it.
  await expect(page.locator(".file-item", { hasText: "c.log" })).toBeVisible({
    timeout: 5000,
  });
  await expect(
    page.locator(".file-item.active", { hasText: "sample.log" }),
  ).toBeVisible();
  await expect(page.locator(".busy-overlay")).toBeHidden();
});

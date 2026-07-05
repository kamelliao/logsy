import { test, expect, dragTo, SAMPLE_LOG } from "./support/fixtures";
import type { Page } from "./support/fixtures";
import type { TauriMock } from "./support/tauri-mock";

// The sidebar starts collapsed (icon-only), which hides group names/labels.
// Expand it so the group UI is visible for these tests.
async function expandSidebar(page: Page) {
  if (await page.locator(".sidebar.collapsed").count()) {
    await page.locator(".sidebar-top button").click();
    await expect(page.locator(".sidebar.collapsed")).toHaveCount(0);
  }
}

// Open two logs as sidebar entries and return once both rows render.
async function openTwo(page: Page, tauri: TauriMock) {
  await tauri.setFile("/logs/a.log", SAMPLE_LOG);
  await tauri.setFile("/logs/b.log", "one\ntwo\n");
  await tauri.setDialogOpen(["/logs/a.log", "/logs/b.log"]);
  await page.locator(".empty-workspace").click();
  await expect(page.locator(".file-item")).toHaveCount(2);
  await expandSidebar(page);
}

// The group section whose header shows `name`.
function group(page: Page, name: string) {
  return page
    .locator(".file-group")
    .filter({ has: page.locator(".fg-name", { hasText: name }) });
}

async function newGroup(page: Page, name: string) {
  await page.locator(".new-tab", { hasText: "New Group" }).click();
  const input = page.locator(".fg-name-input");
  await expect(input).toBeVisible();
  await input.fill(name);
  await input.press("Enter");
  await expect(page.locator(".fg-name", { hasText: name })).toBeVisible();
}

test.describe("file groups", () => {
  test("group a file via its context menu, collapse, and persist", async ({
    page,
    tauri,
  }) => {
    await openTwo(page, tauri);
    await newGroup(page, "Device A");

    // Move a.log into the group through the file's right-click menu.
    await page
      .locator(".file-item", { hasText: "a.log" })
      .click({ button: "right" });
    await page
      .locator(".file-menu .menu-item", { hasText: "Device A" })
      .click();

    const g = group(page, "Device A");
    await expect(g.locator(".file-item", { hasText: "a.log" })).toBeVisible();
    await expect(g.locator(".fg-count")).toHaveText("1");
    // b.log stays ungrouped, above the group.
    await expect(
      page.locator(".fg-ungrouped .file-item", { hasText: "b.log" }),
    ).toBeVisible();

    // Collapsing the group hides its member rows.
    await g.locator(".fg-chevron").click();
    await expect(g.locator(".file-item")).toHaveCount(0);

    // The group + its collapsed state + membership survive a reload.
    await page.reload();
    const g2 = group(page, "Device A");
    await expect(g2).toBeVisible();
    await expect(g2.locator(".file-item")).toHaveCount(0); // still collapsed
    await g2.locator(".fg-chevron").click();
    await expect(g2.locator(".file-item", { hasText: "a.log" })).toBeVisible();
  });

  test("drag an ungrouped file into a group", async ({ page, tauri }) => {
    await openTwo(page, tauri);
    await newGroup(page, "Boot");

    // Seed the group with a.log (via menu) so the drop target has a real row.
    await page
      .locator(".file-item", { hasText: "a.log" })
      .click({ button: "right" });
    await page.locator(".file-menu .menu-item", { hasText: "Boot" }).click();

    const g = group(page, "Boot");
    await expect(g.locator(".file-item")).toHaveCount(1);

    // Drag b.log (still ungrouped) onto a.log inside the group.
    await dragTo(
      page,
      page.locator(".fg-ungrouped .file-item", { hasText: "b.log" }),
      g.locator(".file-item", { hasText: "a.log" }),
    );

    await expect(g.locator(".file-item")).toHaveCount(2);
    await expect(g.locator(".fg-count")).toHaveText("2");
    await expect(page.locator(".fg-ungrouped .file-item")).toHaveCount(0);
  });

  test("ungroup keeps the files", async ({ page, tauri }) => {
    await openTwo(page, tauri);
    await newGroup(page, "Temp");
    await page
      .locator(".file-item", { hasText: "a.log" })
      .click({ button: "right" });
    await page.locator(".file-menu .menu-item", { hasText: "Temp" }).click();
    await expect(group(page, "Temp").locator(".file-item")).toHaveCount(1);

    // Kebab → Ungroup: the group disappears, a.log falls back to ungrouped.
    await group(page, "Temp").locator(".fg-kebab").click();
    await page.locator(".fg-menu .menu-item", { hasText: "Ungroup" }).click();
    await expect(page.locator(".file-group")).toHaveCount(0);
    await expect(page.locator(".file-item")).toHaveCount(2);
  });
});

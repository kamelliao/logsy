import {
  test as base,
  expect,
  type Page,
  type Locator,
} from "@playwright/test";
import { installTauriMock, TauriMock } from "./tauri-mock";

// Every e2e test gets a `tauri` mock installed before the app loads, plus the
// app navigated to `/`. Use `tauri` to register files and dialog results.
export const test = base.extend<{ tauri: TauriMock }>({
  tauri: async ({ page }, use) => {
    const mock = await installTauriMock(page);
    await page.goto("/");
    // Playwright's fixture `use`, not a React Hook.
    // eslint-disable-next-line react-hooks/rules-of-hooks
    await use(mock);
  },
});

export { expect };
export type { Page, Locator };

/**
 * Drive a dnd-kit drag from `source` to `target` via real pointer moves. The
 * PointerSensor needs the press to move past its 5px activation distance, then
 * several intermediate moves so collision detection settles on the drop target.
 */
export async function dragTo(
  page: Page,
  source: Locator,
  target: Locator,
  opts: { steps?: number; targetDy?: number } = {},
) {
  const s = await source.boundingBox();
  const t = await target.boundingBox();
  if (!s || !t) throw new Error("dragTo: source/target not visible");
  const sx = s.x + s.width / 2;
  const sy = s.y + s.height / 2;
  const tx = t.x + t.width / 2;
  const ty = t.y + (opts.targetDy ?? t.height / 2);

  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx, sy + 8, { steps: 5 }); // exceed activation distance
  await page.mouse.move(tx, ty, { steps: opts.steps ?? 16 });
  await page.mouse.move(tx, ty + 1, { steps: 5 }); // nudge so the over-target registers
  // dnd-kit resolves collisions on an animation frame; give it time to commit the
  // drop target before releasing, otherwise a busy machine can drop on stale state.
  await page.waitForTimeout(80);
  await page.mouse.up();
}

// A small, deterministic firmware-style log used across tests. Line numbers are
// 1-based in the UI, matching `r.n`.
export const SAMPLE_LOG = [
  "[0.001] boot: starting up",
  "[0.002] wifi: scanning networks",
  "[0.003] INFO ready",
  "[0.004] ERROR sensor timeout",
  "[0.005] wifi: connected",
  "[0.006] WARN low battery",
  "[0.007] ERROR i2c nak",
  "[0.008] shutdown",
].join("\n");

// A structured log whose lines all match `\[(?<t>[0-9.]+)\] (?<level>\w+) (?<msg>.+)`:
// `t` is numeric (a timeline time-field), `level`/`msg` are compare columns.
export const STRUCTURED_LOG = [
  "[0.001] INFO boot ok",
  "[0.002] WARN low battery",
  "[0.003] ERROR i2c nak",
  "[0.004] INFO ready",
].join("\n");

/** The regex (with named groups) that parses STRUCTURED_LOG into fields. */
export const STRUCTURED_PATTERN =
  "\\[(?<t>[0-9.]+)\\] (?<level>\\w+) (?<msg>.+)";

/**
 * Open a log via the (mocked) file dialog and wait for its rows to render.
 * Returns once the log view is showing the file's lines.
 */
export async function openLog(
  page: Page,
  tauri: TauriMock,
  path = "/logs/sample.log",
  contents = SAMPLE_LOG,
) {
  await tauri.setFile(path, contents);
  await tauri.setDialogOpen(path);
  // The empty-workspace card opens the file dialog on click.
  await page.locator(".empty-workspace").click();
  await expect(page.locator(".log-row").first()).toBeVisible();
}

/** A log row located by its 1-based line number (matched on the gutter, `.log-gut`). */
export function logRow(page: Page, n: number) {
  return page.locator(".log-row").filter({
    has: page.locator(".log-gut", { hasText: new RegExp(`^${n}$`) }),
  });
}

/** Right-click a log line and click an item in its context menu. */
export async function logRowMenu(page: Page, n: number, item: string | RegExp) {
  await logRow(page, n).click({ button: "right" });
  await page.locator(".row-menu").getByText(item).click();
}

/** Switch the dock to a panel tab by its label (Filters / Bookmarks / Timeline / Compare). */
export async function openTab(page: Page, name: string) {
  await page.locator(".ptab", { hasText: name }).click();
}

interface FilterOpts {
  regex?: boolean;
  caseSensitive?: boolean;
  exclude?: boolean;
  description?: string;
}

/** Fill + save the already-open "New filter" EditModal. */
export async function fillNewFilter(
  page: Page,
  pattern: string,
  opts: FilterOpts = {},
) {
  const dialog = page.getByRole("dialog").filter({ hasText: "New filter" });
  if (opts.regex) await dialog.getByText("Regex", { exact: true }).click();
  if (opts.caseSensitive) await dialog.getByText("Case sensitive").click();
  if (opts.exclude) await dialog.getByText("Exclude", { exact: true }).click();
  await dialog
    .getByPlaceholder(opts.regex ? "e.g.  ERROR|WARN|fail" : "e.g.  wifi")
    .fill(pattern);
  if (opts.description !== undefined)
    await dialog
      .getByPlaceholder("What is this filter for?")
      .fill(opts.description);
  // Footer button reads "Add filter" for a new filter.
  await dialog.getByRole("button", { name: "Add filter" }).click();
  await expect(dialog).toBeHidden();
}

/** Add a filter through the panel toolbar + EditModal, then save it. */
export async function addFilter(
  page: Page,
  pattern: string,
  opts: FilterOpts = {},
) {
  await page.getByRole("button", { name: "Add filter", exact: true }).click();
  await fillNewFilter(page, pattern, opts);
}

/** A filter row located by its visible label (pattern or description). */
export function filterRow(page: Page, label: string) {
  return page
    .locator(".filter-row")
    .filter({ has: page.locator(".fr-pattern", { hasText: label }) });
}

/** Open the panel toolbar's "More actions" menu and click an item by name. */
export async function panelMenu(page: Page, item: string | RegExp) {
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: item }).click();
}

/** Open a filter row's "More" menu and click an item by name. */
export async function rowMenu(
  page: Page,
  label: string,
  item: string | RegExp,
) {
  await filterRow(page, label).getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: item }).click();
}

/** Add an (empty) filter group via the toolbar menu. */
export async function addGroup(page: Page) {
  await panelMenu(page, "New group");
}

/** Add a new filter set (tab). */
export async function addSet(page: Page) {
  await page.locator(".gtab-add").click();
}

/** Enter batch-selection mode via the toolbar menu. */
export async function enterSelectMode(page: Page) {
  await panelMenu(page, "Select filters");
  await expect(page.locator(".select-bar")).toBeVisible();
}

/** Resolve the app's confirm dialog by clicking the button with `label`. */
export async function confirmDialog(page: Page, label: string) {
  const dlg = page.locator(".confirm-modal");
  await dlg.getByRole("button", { name: label }).click();
  await expect(dlg).toBeHidden();
}

/**
 * Export the active filter set via "Save filters as…" and return the JSON that
 * the app handed to `write_text_file`. Handy for round-trip import tests.
 */
export async function exportFilterSet(
  page: Page,
  tauri: TauriMock,
  path: string,
): Promise<string> {
  await tauri.setDialogSave(path);
  await panelMenu(page, "Save filters as");
  const write = (await tauri.calls()).find((c) => c.cmd === "write_text_file");
  if (!write) throw new Error("exportFilterSet: no write_text_file call");
  return (write.args as { contents: string }).contents;
}

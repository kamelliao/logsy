import type { Page } from "@playwright/test";

// A minimal in-page stand-in for Tauri's IPC. Every `@tauri-apps/api` call
// (invoke, plugin-dialog, the event system behind webview drag-drop) funnels
// through `window.__TAURI_INTERNALS__`; we install our own before any app code
// runs so the frontend behaves as if it were inside the desktop shell.
//
// Tests drive it through the `TauriMock` helper returned by `installTauriMock`:
// register file contents, queue dialog results, fire a drag-drop, and inspect
// the calls the app made (e.g. what it asked `write_text_file` to write).

export interface TauriMockState {
  /** path -> file contents the `read_text_file` command will return. */
  files: Record<string, { text: string; encoding: string }>;
  /** Result of the next `plugin:dialog|open` (a path, list of paths, or null). */
  dialogOpen: string | string[] | null;
  /** Result of the next `plugin:dialog|save` (a path or null). */
  dialogSave: string | null;
  /** Every command the app invoked, in order — assertion surface for writes etc. */
  calls: { cmd: string; args: unknown }[];
}

// Runs in the browser via addInitScript. Self-contained (no imports / closures
// over Node scope) because Playwright serializes it to a string.
function initScript() {
  // Files survive a page.reload() (localStorage outlives the document) so the
  // reload-on-restart path can re-read them, mirroring the desktop app reopening
  // files from disk. Dialog results and the call log reset on reload, as they
  // would for a fresh session.
  const FILES_KEY = "__tauri_mock_files__";
  const state = {
    files: JSON.parse(localStorage.getItem(FILES_KEY) || "{}") as Record<
      string,
      { text: string; encoding: string }
    >,
    dialogOpen: null as string | string[] | null,
    dialogSave: null as string | null,
    calls: [] as { cmd: string; args: unknown }[],
  };
  const callbacks = new Map<number, (payload: unknown) => void>();
  // Each `listen` registration, keyed by the event-id we hand back so `unlisten`
  // can remove exactly that one. Proper removal matters: React StrictMode mounts
  // effects twice in dev, so a no-op unlisten would leave a duplicate listener
  // and fire drag-drop handlers (and load files) twice.
  const listeners = new Map<number, { event: string; handler: number }>();
  let nextCbId = 1;
  let nextEventId = 1;

  // Deliver to the most-recently-registered listener for an event. In production
  // each Tauri event has exactly one listener, so this matches real delivery.
  // In dev, React StrictMode mounts effects twice (and React 19 doesn't run the
  // first cleanup before the async unlisten settles), leaving a stale duplicate
  // listener; delivering only to the latest avoids firing handlers — and loading
  // dropped files — twice.
  function dispatch(event: string, payload: unknown) {
    let handler: number | undefined;
    for (const l of listeners.values())
      if (l.event === event) handler = l.handler;
    if (handler !== undefined)
      callbacks.get(handler)?.({ event, id: handler, payload });
  }

  async function invoke(cmd: string, args: Record<string, unknown> = {}) {
    state.calls.push({ cmd, args });
    switch (cmd) {
      case "read_text_file": {
        const f = state.files[args.path as string];
        if (!f) throw new Error(`mock: no file registered at ${args.path}`);
        return { text: f.text, encoding: f.encoding };
      }
      case "write_text_file":
      case "open_url":
      case "window_controls":
        return null;
      case "plugin:dialog|open":
        return state.dialogOpen;
      case "plugin:dialog|save":
        return state.dialogSave;
      case "plugin:app|version":
        return "0.0.0-e2e";
      case "plugin:event|listen": {
        const eventId = nextEventId++;
        listeners.set(eventId, {
          event: args.event as string,
          handler: args.handler as number,
        });
        return eventId;
      }
      case "plugin:event|unlisten":
        listeners.delete(args.eventId as number);
        return null;
      case "plugin:event|emit":
      case "plugin:event|emit_to":
        dispatch(args.event as string, args.payload);
        return null;
      default:
        // Be permissive: unknown plugin calls resolve to null rather than throw.
        return null;
    }
  }

  // The surface @tauri-apps/api expects on the global.
  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ =
    {
      metadata: {
        currentWindow: { label: "main" },
        currentWebview: { label: "main" },
      },
      transformCallback(cb: (payload: unknown) => void) {
        const id = nextCbId++;
        callbacks.set(id, cb);
        return id;
      },
      unregisterCallback(id: number) {
        callbacks.delete(id);
      },
      invoke,
    };

  // Test-control surface (read/written via page.evaluate from the helper).
  (window as unknown as { __TAURI_MOCK__: unknown }).__TAURI_MOCK__ = {
    state,
    // Simulate an OS file drag-drop onto the window. `onDragDropEvent` listens on
    // tauri://drag-* and reshapes the payload, so we feed the raw shape it wants.
    drop(paths: string[]) {
      dispatch("tauri://drag-enter", { paths, position: { x: 1, y: 1 } });
      dispatch("tauri://drag-drop", { paths, position: { x: 1, y: 1 } });
    },
    // Number of live listeners for an event — lets tests wait for React's
    // (StrictMode, dev-only) double-mount of the drag-drop effect to settle.
    listenerCount(event: string) {
      let n = 0;
      for (const l of listeners.values()) if (l.event === event) n++;
      return n;
    },
  };
}

declare global {
  interface Window {
    __TAURI_MOCK__: {
      state: TauriMockState;
      drop(paths: string[]): void;
      listenerCount(event: string): number;
    };
  }
}

export class TauriMock {
  constructor(private page: Page) {}

  /** Register file contents that `read_text_file` (and drag-drop) will serve. */
  async setFile(path: string, text: string, encoding = "UTF-8") {
    await this.page.evaluate(
      ({ path, text, encoding }) => {
        const s = window.__TAURI_MOCK__.state;
        s.files[path] = { text, encoding };
        // Persist so the file is still served after a page.reload().
        localStorage.setItem("__tauri_mock_files__", JSON.stringify(s.files));
      },
      { path, text, encoding },
    );
  }

  /** Queue the result the next open-file dialog should return. */
  async setDialogOpen(result: string | string[] | null) {
    await this.page.evaluate((r) => {
      window.__TAURI_MOCK__.state.dialogOpen = r;
    }, result);
  }

  /** Queue the result the next save dialog should return. */
  async setDialogSave(result: string | null) {
    await this.page.evaluate((r) => {
      window.__TAURI_MOCK__.state.dialogSave = r;
    }, result);
  }

  /** Fire an OS drag-drop of the given paths onto the window. */
  async drop(paths: string[]) {
    // Wait for the app's drag-drop listener to be registered first, so the event
    // isn't dropped on the floor when fired right after load.
    await this.page.waitForFunction(
      () => window.__TAURI_MOCK__.listenerCount("tauri://drag-drop") > 0,
    );
    await this.page.evaluate((p) => window.__TAURI_MOCK__.drop(p), paths);
  }

  /** All commands the app invoked so far (e.g. to assert export payloads). */
  async calls(): Promise<{ cmd: string; args: unknown }[]> {
    return this.page.evaluate(() => window.__TAURI_MOCK__.state.calls);
  }
}

/** Install the Tauri IPC mock on a page before app code runs. */
export async function installTauriMock(page: Page): Promise<TauriMock> {
  await page.addInitScript(initScript);
  return new TauriMock(page);
}

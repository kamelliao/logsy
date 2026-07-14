import { useEffect, useRef } from "react";
import { tinykeys } from "tinykeys";
import { useStore } from "@/store";
import { useShallow } from "zustand/react/shallow";

interface OpenMenu {
  name: string;
  x: number;
  y: number;
}

interface Deps {
  // Menubar keyboard navigation.
  menus: readonly string[];
  openMenu: OpenMenu | null;
  setOpenMenu: (m: OpenMenu | null) => void;

  // tinykeys-driven actions ($mod = Ctrl/Cmd). undo/redo/zoom/openNewFilter and
  // `editing` are read from the store; the rest are App-local / IO handlers.
  openFiles: () => void | Promise<void>;
  /** Ctrl+P: the Quick Open palette (fuzzy-jump to an already-open log). */
  openQuickOpen: () => void;
  fileViewMode: "all" | "matches";
  setViewMode: (m: "all" | "matches") => void;
  setFindOpen: (v: boolean) => void;
  // Ctrl+F: open the find bar *and* focus its input (re-focuses when already open).
  focusFind: () => void;
  // Ctrl+\: split the focused pane — open one more beside it on the same log.
  splitPane: () => void;
  // Ctrl+Shift+\: close the focused pane (no-op when it's the only one).
  closePane: () => void;

  // Escape stack (innermost overlay first).
  findOpen: boolean;
  openScreen: boolean;
  filesCount: number;
  setOpenScreen: (v: boolean) => void;
  shortcutsOpen: boolean;
  setShortcutsOpen: (v: boolean) => void;
  aboutOpen: boolean;
  setAboutOpen: (v: boolean) => void;

  // Ctrl+B/G + Ctrl+Shift+L (plain keydown listener).
  toggleFilterCollapsed: () => void;
  openGoto: () => void;
  focusFilterSearch: () => void;
}

/**
 * All app-global keyboard handling: the tinykeys map, the menubar arrow-key
 * navigation, the plain Ctrl+Z/Y/B/G/R + Ctrl+Shift+N/L listener, and the
 * native context-menu suppression. Split out of App so the component body stays
 * about state and rendering rather than event wiring.
 */
export function useKeyboardShortcuts(deps: Deps): void {
  const {
    menus,
    openMenu,
    setOpenMenu,
    openFiles,
    openQuickOpen,
    fileViewMode,
    setViewMode,
    setFindOpen,
    focusFind,
    splitPane,
    closePane,
    findOpen,
    openScreen,
    filesCount,
    setOpenScreen,
    shortcutsOpen,
    setShortcutsOpen,
    aboutOpen,
    setAboutOpen,
  } = deps;

  // Undo/redo, zoom, "new filter" and the open editor draft live in the store.
  const editing = useStore((s) => s.editing);
  const { undo, redo, zoomIn, zoomOut, zoomReset, openNewFilter } = useStore(
    useShallow((s) => ({
      undo: s.undo,
      redo: s.redo,
      zoomIn: s.zoomIn,
      zoomOut: s.zoomOut,
      zoomReset: s.zoomReset,
      openNewFilter: s.openNewFilter,
    })),
  );

  // While a menu is open, Left/Right move to the adjacent top-level menu and
  // Esc closes it (matches native menubar keyboard navigation).
  useEffect(() => {
    if (!openMenu) return;
    const close = () => setOpenMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpenMenu(null);
        return;
      }
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      const i = menus.indexOf(openMenu.name);
      if (i < 0) return;
      const ni =
        (i + (e.key === "ArrowRight" ? 1 : -1) + menus.length) % menus.length;
      const el = document.querySelector(`[data-menu="${menus[ni]}"]`);
      if (el) {
        const r = el.getBoundingClientRect();
        setOpenMenu({ name: menus[ni], x: r.left, y: r.bottom });
      }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [openMenu, menus, setOpenMenu]);

  useEffect(() => {
    return tinykeys(window, {
      "$mod+o": (e) => {
        e.preventDefault();
        void openFiles();
      },
      "$mod+p": (e) => {
        e.preventDefault();
        openQuickOpen();
      },
      "$mod+f": (e) => {
        e.preventDefault();
        focusFind();
      },
      "$mod+F": (e) => {
        e.preventDefault();
        focusFind();
      },
      "$mod+\\": (e) => {
        e.preventDefault();
        splitPane();
      },
      "$mod+Shift+\\": (e) => {
        e.preventDefault();
        closePane();
      },
      "$mod+h": (e) => {
        e.preventDefault();
        setViewMode(fileViewMode === "all" ? "matches" : "all");
      },
      "$mod+H": (e) => {
        e.preventDefault();
        setViewMode(fileViewMode === "all" ? "matches" : "all");
      },
      "$mod+=": (e) => {
        e.preventDefault();
        zoomIn();
      },
      "$mod+shift+=": (e) => {
        e.preventDefault();
        zoomIn();
      },
      "$mod+-": (e) => {
        e.preventDefault();
        zoomOut();
      },
      "$mod+0": (e) => {
        e.preventDefault();
        zoomReset();
      },
      Escape: () => {
        if (shortcutsOpen) setShortcutsOpen(false);
        else if (aboutOpen) setAboutOpen(false);
        else if (findOpen && !editing) setFindOpen(false);
        // Leave the open screen (back to the active file) if there's one to show.
        else if (openScreen && filesCount > 0) setOpenScreen(false);
      },
    });
  }, [
    findOpen,
    editing,
    openScreen,
    filesCount,
    fileViewMode,
    zoomIn,
    zoomOut,
    zoomReset,
    shortcutsOpen,
    aboutOpen,
    openFiles,
    openQuickOpen,
    setFindOpen,
    focusFind,
    splitPane,
    closePane,
    setViewMode,
    setOpenScreen,
    setShortcutsOpen,
    setAboutOpen,
  ]);

  // Latest handlers for the once-mounted listeners below, so they never call a
  // stale closure (openNewFilter reads `set`, toggleFilterCollapsed reads the
  // current layout, etc.).
  const ref = useRef({
    undo,
    redo,
    toggleFilterCollapsed: deps.toggleFilterCollapsed,
    openGoto: deps.openGoto,
    openNewFilter,
    focusFilterSearch: deps.focusFilterSearch,
  });
  ref.current = {
    undo,
    redo,
    toggleFilterCollapsed: deps.toggleFilterCollapsed,
    openGoto: deps.openGoto,
    openNewFilter,
    focusFilterSearch: deps.focusFilterSearch,
  };

  // Ctrl+B (toggle filter panel), Ctrl+G (go to line) and Ctrl+R (reload) on a
  // plain keydown listener — robust regardless of focus or keymap quirks. Kept
  // off tinykeys so there's exactly one handler (no double-toggle).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      // Undo / redo — but let the browser's native undo handle editable fields
      // (filter editor, inline rename) so typing isn't clobbered.
      if (k === "z" || k === "y") {
        const t = e.target as HTMLElement | null;
        if (t && t.closest('input, textarea, [contenteditable="true"]')) return;
        e.preventDefault();
        if (k === "y" || e.shiftKey) ref.current.redo();
        else ref.current.undo();
        return;
      }
      if (e.shiftKey) {
        // Ctrl+Shift+N: new filter · Ctrl+Shift+L: focus the filter search box.
        if (k === "n") {
          e.preventDefault();
          ref.current.openNewFilter();
        } else if (k === "l") {
          e.preventDefault();
          ref.current.focusFilterSearch();
        }
        return;
      }
      if (k === "b") {
        e.preventDefault();
        ref.current.toggleFilterCollapsed();
      } else if (k === "g") {
        e.preventDefault();
        ref.current.openGoto();
      } else if (k === "r") {
        e.preventDefault();
        location.reload();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Suppress the native browser context menu app-wide, except inside editable
  // fields (so right-click copy/paste still works there). The app's own
  // right-click menus are React handlers and are unaffected.
  useEffect(() => {
    function onCtx(e: MouseEvent) {
      const t = e.target as HTMLElement | null;
      if (t && t.closest('input, textarea, [contenteditable="true"]')) return;
      e.preventDefault();
    }
    window.addEventListener("contextmenu", onCtx);
    return () => window.removeEventListener("contextmenu", onCtx);
  }, []);
}

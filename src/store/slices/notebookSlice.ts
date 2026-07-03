import { uid } from "@/lib/defaults";
import type { Notebook } from "@/types";
import type { Store, StoreSet, StoreGet } from "@/store";

/**
 * App-level notebooks (reports). They live BESIDE the workspace doc as top-level
 * store state (`notebooks` / `activeNotebookId`) — persisted under their own
 * key, and deliberately not part of `doc`: keeping them there put their embed
 * payloads (timeline PNG data URLs) on every undo snapshot + doc serialize, and
 * let an app-level undo resurrect a deleted notebook. The TipTap editor keeps
 * its own internal undo history per notebook, so the app's Ctrl+Z stack stays
 * focused on the log/filter document.
 */
export interface NotebookState {
  notebooks: Notebook[];
  activeNotebookId: string | null;
}

export interface NotebookActions {
  /** Create a notebook (optionally named) and make it active; returns its id. */
  createNotebook: (name?: string) => string;
  renameNotebook: (id: string, name: string) => void;
  deleteNotebook: (id: string) => void;
  setActiveNotebook: (id: string) => void;
  /** Persist the editor's serialized doc JSON (autosave, debounced by the caller). */
  saveNotebookDoc: (id: string, doc: Record<string, unknown>) => void;
  /** Return the active notebook's id, creating a first one if none exists. Used
   *  by "Add to notebook" so a capture always has a target. */
  ensureNotebook: () => string;
}

export function createNotebookActions(
  set: StoreSet,
  get: StoreGet,
): NotebookState & NotebookActions {
  const create = (name?: string): string => {
    const id = uid("nb");
    const now = Date.now();
    set((s: Store) => ({
      notebooks: [
        ...s.notebooks,
        {
          id,
          name: name?.trim() || "Untitled",
          doc: null,
          createdAt: now,
          updatedAt: now,
        },
      ],
      activeNotebookId: id,
    }));
    return id;
  };

  return {
    notebooks: [],
    activeNotebookId: null,

    createNotebook: create,

    renameNotebook: (id, name) =>
      set((s: Store) => ({
        notebooks: s.notebooks.map((n) =>
          n.id === id
            ? { ...n, name: name.trim() || n.name, updatedAt: Date.now() }
            : n,
        ),
      })),

    deleteNotebook: (id) =>
      set((s: Store) => {
        const notebooks = s.notebooks.filter((n) => n.id !== id);
        return {
          notebooks,
          // Keep a valid selection: fall back to the first remaining notebook,
          // or null (panel shows its empty state) when the last one is gone.
          activeNotebookId:
            s.activeNotebookId === id
              ? (notebooks[0]?.id ?? null)
              : s.activeNotebookId,
        };
      }),

    setActiveNotebook: (id) =>
      set((s: Store) =>
        s.notebooks.some((n) => n.id === id) ? { activeNotebookId: id } : {},
      ),

    saveNotebookDoc: (id, doc) =>
      set((s: Store) => ({
        notebooks: s.notebooks.map((n) =>
          n.id === id ? { ...n, doc, updatedAt: Date.now() } : n,
        ),
      })),

    ensureNotebook: () => {
      const s = get();
      const active = s.notebooks.find((n) => n.id === s.activeNotebookId);
      return active ? active.id : create();
    },
  };
}

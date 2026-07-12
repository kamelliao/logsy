import { useState, useRef, useEffect, useMemo } from "react";
import {
  Plus,
  Pencil,
  Trash2,
  NotebookPen,
  Check,
  Search,
  ChevronDown,
  FolderOpen,
} from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { Combobox } from "@base-ui/react/combobox";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { NoteEditor } from "./NoteEditor";
import type { Notebook } from "@/types";
import { baseName } from "@/lib/path";
import { useStore } from "@/store";

/**
 * Open a notebook exported with "Export as JSON". That export is the editor's raw
 * TipTap doc (`editor.getJSON()`), so that's the shape we expect — but a file
 * holding a whole `Notebook` object (`{ name, doc }`) is accepted too, since that's
 * the other plausible thing a user could point at.
 */
async function openNotebookFile(): Promise<void> {
  const path = await open({
    multiple: false,
    filters: [{ name: "Notebook", extensions: ["json"] }],
  });
  if (typeof path !== "string") return;

  let raw: string;
  try {
    const res = await invoke<{ text: string }>("read_text_file", {
      path,
      encoding: null,
    });
    raw = res.text;
  } catch (e) {
    toast.error("Could not read that file: " + String(e));
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    toast.error("That file isn't valid JSON.");
    return;
  }

  const asRecord = (v: unknown): Record<string, unknown> | null =>
    v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  const isTipTapDoc = (v: Record<string, unknown> | null): boolean =>
    !!v && v.type === "doc" && Array.isArray(v.content);

  const top = asRecord(parsed);
  // A bare TipTap doc (what we export), or a Notebook wrapping one.
  const wrapped = asRecord(top?.doc);
  const doc = isTipTapDoc(top) ? top : isTipTapDoc(wrapped) ? wrapped : null;
  if (!doc) {
    toast.error("That JSON isn't a Logsy notebook.");
    return;
  }
  // Prefer the name the file carries; otherwise the filename without its extension.
  const embeddedName = typeof top?.name === "string" ? top.name.trim() : "";
  const name =
    embeddedName || baseName(path).replace(/\.json$/i, "") || "Untitled";

  useStore.getState().importNotebook(name, doc);
  toast.success(`Opened notebook “${name}”`);
}

// Relative "2h ago" / "3d ago", falling back to a short date past a week — keeps
// the combobox rows scannable while the full timestamps live in the row title.
const fmtWhen = (ms: number): string => {
  if (!ms) return "";
  const diff = Date.now() - ms;
  const m = 60_000,
    h = 3_600_000,
    d = 86_400_000;
  if (diff < m) return "just now";
  if (diff < h) return `${Math.floor(diff / m)}m ago`;
  if (diff < d) return `${Math.floor(diff / h)}h ago`;
  if (diff < 7 * d) return `${Math.floor(diff / d)}d ago`;
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
    }).format(ms);
  } catch {
    return "";
  }
};

const fmtFull = (ms: number): string => {
  if (!ms) return "—";
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(ms);
  } catch {
    return "";
  }
};

/** Searchable notebook switcher. Each row shows the name plus when it was last
 *  edited and created; the full timestamps sit in the row's hover title. */
function NotebookCombobox({
  notebooks,
  activeId,
  onSelect,
}: {
  notebooks: Notebook[];
  activeId: string | null;
  onSelect: (id: string) => void;
}) {
  const ids = useMemo(() => notebooks.map((n) => n.id), [notebooks]);
  const byId = useMemo(
    () => new Map(notebooks.map((n) => [n.id, n])),
    [notebooks],
  );
  const nameOf = (id: string) => byId.get(id)?.name ?? "Untitled";

  return (
    <Combobox.Root
      items={ids}
      value={activeId}
      onValueChange={(v) => {
        if (typeof v === "string") onSelect(v);
      }}
      itemToStringLabel={nameOf}
    >
      <Combobox.Trigger className="nb-combo-trigger" title="Switch notebook">
        <span className="nb-combo-triggertext">
          {activeId ? nameOf(activeId) : "Select notebook"}
        </span>
        <ChevronDown size={14} className="nb-combo-chevron" />
      </Combobox.Trigger>
      <Combobox.Portal>
        <Combobox.Positioner
          side="bottom"
          align="start"
          sideOffset={4}
          style={{ zIndex: 1000 }}
        >
          <Combobox.Popup className="menu-pop cc-popup nb-combo-popup">
            <div className="cc-search">
              <Search size={14} />
              <Combobox.Input
                placeholder="Search notebooks…"
                className="cc-input"
              />
            </div>
            <Combobox.Empty className="cc-empty">
              No notebooks found
            </Combobox.Empty>
            <Combobox.List className="cc-list scroll">
              {(id: string) => {
                const n = byId.get(id);
                return (
                  <Combobox.Item
                    key={id}
                    value={id}
                    className="cc-item nb-combo-item"
                  >
                    <span className="nb-combo-item-main">
                      <span
                        className="cc-item-name"
                        style={{ textTransform: "none" }}
                      >
                        {nameOf(id)}
                      </span>
                      {n && (
                        <span
                          className="nb-combo-meta"
                          title={`Created ${fmtFull(n.createdAt)}\nEdited ${fmtFull(n.updatedAt)}`}
                        >
                          Edited {fmtWhen(n.updatedAt)} · Created{" "}
                          {fmtWhen(n.createdAt)}
                        </span>
                      )}
                    </span>
                    <span className="enc-check">
                      <Combobox.ItemIndicator>
                        <Check size={13} />
                      </Combobox.ItemIndicator>
                    </span>
                  </Combobox.Item>
                );
              }}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}

/** Header bar: switch between notebooks, create, rename inline, delete. */
function NotebookBar() {
  const notebooks = useStore((s) => s.notebooks);
  const activeId = useStore((s) => s.activeNotebookId);
  const {
    createNotebook,
    renameNotebook,
    deleteNotebook,
    setActiveNotebook,
    confirm,
  } = useStore(
    useShallow((s) => ({
      createNotebook: s.createNotebook,
      renameNotebook: s.renameNotebook,
      deleteNotebook: s.deleteNotebook,
      setActiveNotebook: s.setActiveNotebook,
      confirm: s.confirm,
    })),
  );
  const active = notebooks.find((n) => n.id === activeId) ?? null;

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const startRename = () => {
    if (!active) return;
    setDraft(active.name);
    setEditing(true);
  };
  const commitRename = () => {
    if (active && draft.trim()) renameNotebook(active.id, draft);
    setEditing(false);
  };

  const askDelete = async () => {
    if (!active) return;
    const ok = await confirm({
      title: "Delete notebook?",
      message: `Delete “${active.name}”? This can't be undone.`,
      okLabel: "Delete",
      cancelLabel: "Cancel",
    });
    if (ok) deleteNotebook(active.id);
  };

  return (
    <div className="nb-bar">
      {editing ? (
        <input
          ref={inputRef}
          className="nb-bar-rename"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            else if (e.key === "Escape") setEditing(false);
          }}
          onBlur={commitRename}
        />
      ) : (
        <NotebookCombobox
          notebooks={notebooks}
          activeId={activeId}
          onSelect={setActiveNotebook}
        />
      )}
      <div className="nb-bar-actions">
        {editing ? (
          <button className="nb-bar-btn" title="Done" onClick={commitRename}>
            <Check size={14} />
          </button>
        ) : (
          <button
            className="nb-bar-btn"
            title="Rename notebook"
            onClick={startRename}
          >
            <Pencil size={14} />
          </button>
        )}
        <button
          className="nb-bar-btn"
          title="Open notebook… (.json)"
          onClick={() => void openNotebookFile()}
        >
          <FolderOpen size={14} />
        </button>
        <button
          className="nb-bar-btn"
          title="New notebook"
          onClick={() => createNotebook()}
        >
          <Plus size={15} />
        </button>
        <button
          className="nb-bar-btn nb-bar-btn-danger"
          title="Delete notebook"
          onClick={() => void askDelete()}
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
}

export function NotebookPanel() {
  const hasActive = useStore((s) =>
    Boolean(
      s.activeNotebookId &&
      s.notebooks.some((n) => n.id === s.activeNotebookId),
    ),
  );
  const activeName = useStore(
    (s) =>
      s.notebooks.find((n) => n.id === s.activeNotebookId)?.name ?? "notebook",
  );
  const createNotebook = useStore((s) => s.createNotebook);

  if (!hasActive) {
    return (
      <div className="nb-panel nb-empty">
        <NotebookPen size={32} className="nb-empty-icon" />
        <p className="nb-empty-title">No notebook yet</p>
        <p className="nb-empty-sub">
          Create one to collect findings from any of your open logs — or open a
          notebook you exported earlier.
        </p>
        <div className="nb-empty-actions">
          <button className="nb-empty-btn" onClick={() => createNotebook()}>
            <Plus size={15} />
            New notebook
          </button>
          <button
            className="nb-empty-btn nb-empty-btn-quiet"
            onClick={() => void openNotebookFile()}
          >
            <FolderOpen size={14} />
            Open notebook…
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="nb-panel">
      <NotebookBar />
      <NoteEditor onGetTitle={() => activeName} />
    </div>
  );
}

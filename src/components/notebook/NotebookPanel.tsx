import { useState, useRef, useEffect, useMemo } from "react";
import { Plus, Pencil, Trash2, NotebookPen, Check } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { NoteEditor } from "./NoteEditor";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { useStore } from "@/store";

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
  // Lets SelectValue render the active notebook's NAME (the value is its id).
  const items = useMemo(
    () => notebooks.map((n) => ({ value: n.id, label: n.name })),
    [notebooks],
  );

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
        <Select
          items={items}
          value={activeId}
          onValueChange={(v) => v && setActiveNotebook(v)}
        >
          <SelectTrigger
            size="sm"
            className="min-w-0 flex-1 font-semibold"
            title="Switch notebook"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {notebooks.map((n) => (
              <SelectItem key={n.id} value={n.id}>
                {n.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
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
          Create one to collect findings from any of your open logs.
        </p>
        <button className="nb-empty-btn" onClick={() => createNotebook()}>
          <Plus size={15} />
          New notebook
        </button>
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

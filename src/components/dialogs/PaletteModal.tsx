import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import { GripVertical, RotateCcw, X } from "lucide-react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  arrayMove,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import {
  restrictToVerticalAxis,
  restrictToParentElement,
} from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
import type { PaletteEntry } from "@/types";
import { DEFAULT_PALETTE, TEXT_SWATCHES, BG_SWATCHES } from "@/lib/palette";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

// ---- types -----------------------------------------------------------------

type PaletteRow = PaletteEntry & { _id: string };

let _counter = 0;
function mkId() {
  return `pal_${_counter++}`;
}

function toRows(entries: PaletteEntry[]): PaletteRow[] {
  return entries.map((e) => ({ ...e, _id: mkId() }));
}
function toEntries(rows: PaletteRow[]): PaletteEntry[] {
  return rows.map(({ _id: _, ...rest }) => rest);
}

function autoName(text: string, bg: string): string {
  const t = TEXT_SWATCHES.find(
    (s) => s.color.toLowerCase() === text.toLowerCase(),
  )?.name;
  const b = BG_SWATCHES.find(
    (s) => s.color.toLowerCase() === bg.toLowerCase(),
  )?.name;
  if (t && b) return `${t}/${b}`;
  return b ?? t ?? bg;
}

// ---- combined text+bg color picker ----------------------------------------

interface ColorPairPickerProps {
  text: string;
  bg: string;
  onTextChange: (color: string) => void;
  onBgChange: (color: string) => void;
}

function ColorPairPicker({
  text,
  bg,
  onTextChange,
  onBgChange,
}: ColorPairPickerProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ bottom: number; left: number } | null>(null);
  const [hexText, setHexText] = useState(text);
  const [hexBg, setHexBg] = useState(bg);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setHexText(text);
  }, [text]);
  useEffect(() => {
    setHexBg(bg);
  }, [bg]);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (
        !panelRef.current?.contains(e.target as Node) &&
        !triggerRef.current?.contains(e.target as Node)
      )
        setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  function handleOpen() {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect)
      setPos({ bottom: window.innerHeight - rect.top + 4, left: rect.left });
    setOpen((v) => !v);
  }

  function commitHex(raw: string, which: "text" | "bg") {
    const v = raw.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(v)) {
      if (which === "text") onTextChange(v.toLowerCase());
      else onBgChange(v.toLowerCase());
    } else {
      if (which === "text") setHexText(text);
      else setHexBg(bg);
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="cpp-trigger"
        style={{ background: bg, color: text }}
        onClick={handleOpen}
        title="Pick text & background colors"
      >
        A
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={panelRef}
            className="cpp-panel menu-pop"
            style={{
              position: "fixed",
              bottom: pos.bottom,
              left: pos.left,
              zIndex: 200,
            }}
          >
            <div className="cpp-section-label">Text</div>
            <div className="csp-swatches">
              {TEXT_SWATCHES.map((opt) => (
                <button
                  key={opt.color}
                  type="button"
                  className={
                    "csp-swatch" +
                    (opt.color.toLowerCase() === text.toLowerCase()
                      ? " active"
                      : "")
                  }
                  style={{ background: opt.color }}
                  title={opt.name}
                  onClick={() => {
                    onTextChange(opt.color);
                    setHexText(opt.color);
                  }}
                />
              ))}
            </div>
            <div className="csp-custom">
              <input
                type="color"
                className="csp-native"
                value={/^#[0-9a-fA-F]{6}$/.test(hexText) ? hexText : text}
                onChange={(e) => {
                  setHexText(e.target.value);
                  onTextChange(e.target.value);
                }}
              />
              <input
                type="text"
                className="csp-hex"
                value={hexText}
                maxLength={7}
                spellCheck={false}
                onChange={(e) => setHexText(e.target.value)}
                onBlur={(e) => commitHex(e.target.value, "text")}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    commitHex(hexText, "text");
                    (e.target as HTMLInputElement).blur();
                  }
                  if (e.key === "Escape") setOpen(false);
                }}
              />
            </div>

            <div className="cpp-section-sep" />

            <div className="cpp-section-label">Background</div>
            <div className="csp-swatches">
              {BG_SWATCHES.map((opt) => (
                <button
                  key={opt.color}
                  type="button"
                  className={
                    "csp-swatch" +
                    (opt.color.toLowerCase() === bg.toLowerCase()
                      ? " active"
                      : "")
                  }
                  style={{ background: opt.color }}
                  title={opt.name}
                  onClick={() => {
                    onBgChange(opt.color);
                    setHexBg(opt.color);
                  }}
                />
              ))}
            </div>
            <div className="csp-custom">
              <input
                type="color"
                className="csp-native"
                value={/^#[0-9a-fA-F]{6}$/.test(hexBg) ? hexBg : bg}
                onChange={(e) => {
                  setHexBg(e.target.value);
                  onBgChange(e.target.value);
                }}
              />
              <input
                type="text"
                className="csp-hex"
                value={hexBg}
                maxLength={7}
                spellCheck={false}
                onChange={(e) => setHexBg(e.target.value)}
                onBlur={(e) => commitHex(e.target.value, "bg")}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    commitHex(hexBg, "bg");
                    (e.target as HTMLInputElement).blur();
                  }
                  if (e.key === "Escape") setOpen(false);
                }}
              />
            </div>

            <div
              className="cpp-preview"
              style={{ background: bg, color: text }}
            >
              Sample Text
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

// ---- sortable row ----------------------------------------------------------

function SortablePaletteRow({
  row,
  onRename,
  onDelete,
}: {
  row: PaletteRow;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(row.name);
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: row._id });

  function commit() {
    const v = val.trim();
    if (v) onRename(row._id, v);
    else setVal(row.name);
    setEditing(false);
  }

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
      }}
      className="pm-row"
    >
      <span className="pm-grip" {...attributes} {...listeners}>
        <GripVertical size={14} />
      </span>
      <span
        className="pm-swatch"
        style={{ background: row.bg, color: row.text }}
      >
        A
      </span>
      {editing ? (
        <input
          className="pm-name-input"
          value={val}
          autoFocus
          onChange={(e) => setVal(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") {
              setVal(row.name);
              setEditing(false);
            }
          }}
        />
      ) : (
        <span
          className="pm-name"
          onDoubleClick={() => {
            setVal(row.name);
            setEditing(true);
          }}
          title="Double-click to rename"
        >
          {row.name}
        </span>
      )}
      <span className="pm-hex-pair">
        <code>{row.text}</code>
        <span className="pm-hex-sep"> / </span>
        <code>{row.bg}</code>
      </span>
      <button
        type="button"
        className="pm-delete"
        onClick={() => onDelete(row._id)}
        title="Remove"
      >
        <X size={13} />
      </button>
    </div>
  );
}

// ---- modal -----------------------------------------------------------------

interface PaletteModalProps {
  palette: PaletteEntry[];
  onChange: (palette: PaletteEntry[]) => void;
  onClose: () => void;
}

export function PaletteModal({
  palette,
  onChange,
  onClose,
}: PaletteModalProps) {
  const [rows, setRows] = useState<PaletteRow[]>(() => toRows(palette));
  const [addText, setAddText] = useState("#1c1f23");
  const [addBg, setAddBg] = useState("#ffffff");
  const [addName, setAddName] = useState("");

  const [resetOpen, setResetOpen] = useState(false);
  const [resetPos, setResetPos] = useState<{
    bottom: number;
    left: number;
  } | null>(null);
  const resetWrapRef = useRef<HTMLDivElement>(null);
  const resetPanelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  useEffect(() => {
    if (!resetOpen) return;
    function onDown(e: MouseEvent) {
      if (
        !resetPanelRef.current?.contains(e.target as Node) &&
        !resetWrapRef.current?.contains(e.target as Node)
      )
        setResetOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [resetOpen]);

  function openReset() {
    const rect = resetWrapRef.current?.getBoundingClientRect();
    if (rect)
      setResetPos({
        bottom: window.innerHeight - rect.top + 6,
        left: rect.left,
      });
    setResetOpen(true);
  }

  function apply(next: PaletteRow[]) {
    setRows(next);
    onChange(toEntries(next));
  }

  function handleDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    setRows((cur) => {
      const from = cur.findIndex((r) => r._id === String(active.id));
      const to = cur.findIndex((r) => r._id === String(over.id));
      const next = arrayMove(cur, from, to);
      onChange(toEntries(next));
      return next;
    });
  }

  function handleRename(id: string, name: string) {
    apply(rows.map((r) => (r._id === id ? { ...r, name } : r)));
  }

  function handleDelete(id: string) {
    apply(rows.filter((r) => r._id !== id));
  }

  const resolvedName = addName.trim() || autoName(addText, addBg);
  const addAlreadyExists = rows.some(
    (r) =>
      r.text.toLowerCase() === addText.toLowerCase() &&
      r.bg.toLowerCase() === addBg.toLowerCase(),
  );

  function handleAdd() {
    if (addAlreadyExists) return;
    apply([
      ...rows,
      { name: resolvedName, text: addText, bg: addBg, _id: mkId() },
    ]);
    setAddName("");
    requestAnimationFrame(() => {
      if (listRef.current)
        listRef.current.scrollTop = listRef.current.scrollHeight;
    });
  }

  function handleReset() {
    const next = toRows(DEFAULT_PALETTE);
    setRows(next);
    onChange(DEFAULT_PALETTE);
  }

  return (
    <>
      <Dialog
        open
        onOpenChange={(o) => {
          if (!o) onClose();
        }}
      >
        <DialogContent style={{ width: 520 }}>
          <DialogHeader>
            <DialogTitle>Color Palette</DialogTitle>
            <Button
              variant="ghost"
              size="icon"
              className="mh-x"
              onClick={onClose}
            >
              <X size={18} />
            </Button>
          </DialogHeader>

          <div className="modal-body pm-body">
            <p className="pm-desc">
              Customise the preset swatches shown in the Color row when editing
              a filter. Double-click a name to rename it.
            </p>

            {/* ── list ── */}
            <div className="pm-list" ref={listRef}>
              {rows.length === 0 ? (
                <div className="pm-empty">No presets. Add one below.</div>
              ) : (
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragEnd={handleDragEnd}
                  modifiers={[restrictToVerticalAxis, restrictToParentElement]}
                >
                  <SortableContext
                    items={rows.map((r) => r._id)}
                    strategy={verticalListSortingStrategy}
                  >
                    {rows.map((row) => (
                      <SortablePaletteRow
                        key={row._id}
                        row={row}
                        onRename={handleRename}
                        onDelete={handleDelete}
                      />
                    ))}
                  </SortableContext>
                </DndContext>
              )}
            </div>

            <div className="pm-sep" />

            {/* ── add section ── */}
            <div className="pm-add-title">New preset</div>
            <div className="pm-add-row">
              <ColorPairPicker
                text={addText}
                bg={addBg}
                onTextChange={setAddText}
                onBgChange={setAddBg}
              />
              <Input
                value={addName}
                placeholder={autoName(addText, addBg)}
                onChange={(e) => setAddName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleAdd();
                }}
              />
              <Button
                disabled={addAlreadyExists}
                title={addAlreadyExists ? "Already in palette" : undefined}
                onClick={handleAdd}
                size="lg"
              >
                Add
              </Button>
            </div>
          </div>

          <DialogFooter>
            <div ref={resetWrapRef}>
              <Button variant="ghost" onClick={openReset}>
                <RotateCcw size={14} data-icon="inline-start" />
                Reset to defaults
              </Button>
            </div>
            <div className="spacer" />
            <Button onClick={onClose}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {resetOpen &&
        resetPos &&
        createPortal(
          <div
            ref={resetPanelRef}
            className="pm-reset-pop menu-pop"
            style={{
              position: "fixed",
              bottom: resetPos.bottom,
              left: resetPos.left,
              zIndex: 200,
            }}
          >
            <p className="pm-reset-msg">
              Reset to the default palette? All custom entries will be removed.
            </p>
            <div className="pm-reset-actions">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setResetOpen(false)}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  handleReset();
                  setResetOpen(false);
                }}
              >
                Reset
              </Button>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

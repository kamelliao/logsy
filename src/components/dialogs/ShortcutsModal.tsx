import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";

interface ShortcutsModalProps {
  onClose: () => void;
}

type Row = { keys: string[]; label: string };
type Section = { title: string; rows: Row[] };

// Grouped reference of every shortcut the app listens for (App.tsx / LogView.tsx).
const SECTIONS: Section[] = [
  {
    title: "File",
    rows: [
      { keys: ["Ctrl", "O"], label: "Open log file" },
      { keys: ["Ctrl", "R"], label: "Reload window" },
    ],
  },
  {
    title: "View",
    rows: [
      { keys: ["Ctrl", "B"], label: "Toggle filter panel" },
      { keys: ["Ctrl", "\\"], label: "Split view" },
      { keys: ["Ctrl", "H"], label: "Show only matched lines" },
      { keys: ["Ctrl", "+"], label: "Zoom in" },
      { keys: ["Ctrl", "−"], label: "Zoom out" },
      { keys: ["Ctrl", "0"], label: "Reset zoom" },
      { keys: ["Ctrl", "Scroll"], label: "Zoom in / out" },
    ],
  },
  {
    title: "Navigation & search",
    rows: [
      { keys: ["Ctrl", "F"], label: "Find in view" },
      { keys: ["Enter"], label: "Next match" },
      { keys: ["Shift", "Enter"], label: "Previous match" },
      { keys: ["Ctrl", "G"], label: "Go to line" },
      { keys: ["Esc"], label: "Close find / clear selection" },
    ],
  },
  {
    title: "Editing",
    rows: [
      { keys: ["Ctrl", "Z"], label: "Undo" },
      { keys: ["Ctrl", "Y"], label: "Redo" },
    ],
  },
  {
    title: "Filters",
    rows: [
      { keys: ["Ctrl", "Shift", "N"], label: "New filter" },
      { keys: ["Ctrl", "Shift", "L"], label: "Focus filter search" },
      {
        keys: ["Ctrl", "Click"],
        label: "Select filters (enter selection mode)",
      },
      { keys: ["Shift", "Click"], label: "Extend the selection by range" },
      { keys: ["Esc"], label: "Leave selection mode" },
    ],
  },
  {
    title: "Timeline",
    rows: [
      { keys: ["W", "S"], label: "Zoom in / out" },
      { keys: ["A", "D"], label: "Pan left / right" },
      { keys: ["Scroll"], label: "Scroll lanes vertically" },
      { keys: ["Ctrl", "Scroll"], label: "Zoom in / out" },
      { keys: ["Drag"], label: "Measure Δ (snaps to events)" },
      { keys: ["Shift", "Drag"], label: "Pan the view" },
      { keys: ["Click"], label: "Jump to the event's line" },
    ],
  },
  {
    title: "Log lines",
    rows: [
      { keys: ["Ctrl", "A"], label: "Select all visible lines" },
      { keys: ["Ctrl", "C"], label: "Copy selected lines" },
      { keys: ["Shift", "Click"], label: "Select a range" },
      { keys: ["Ctrl", "Click"], label: "Add / remove from selection" },
      { keys: ["Alt", "Click"], label: "Toggle parsed fields" },
      { keys: ["Space"], label: "Toggle parsed fields" },
      { keys: ["→"], label: "Expand parsed fields" },
      { keys: ["←"], label: "Collapse parsed fields" },
    ],
  },
  {
    title: "Bookmarks",
    rows: [
      { keys: ["Ctrl", "D"], label: "Toggle bookmark on the selected line" },
      { keys: ["Ctrl", "."], label: "Next bookmark" },
      { keys: ["Ctrl", ","], label: "Previous bookmark" },
    ],
  },
];

export function ShortcutsModal({ onClose }: ShortcutsModalProps) {
  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="shortcuts-modal" style={{ width: 620 }}>
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <Button
            variant="ghost"
            size="icon"
            className="mh-x"
            onClick={onClose}
          >
            <X size={18} />
          </Button>
        </DialogHeader>
        <div className="modal-body scroll">
          <div className="shortcuts-grid">
            {SECTIONS.map((sec) => (
              <div key={sec.title} className="shortcuts-section">
                <div className="shortcuts-section-title">{sec.title}</div>
                {sec.rows.map((row, i) => (
                  <div key={i} className="shortcuts-row">
                    <span className="shortcuts-label">{row.label}</span>
                    <span className="shortcuts-keys">
                      {row.keys.map((k, j) => (
                        <Kbd key={j}>{k}</Kbd>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

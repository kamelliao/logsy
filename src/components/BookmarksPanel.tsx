import { Bookmark, Trash2 } from "lucide-react";
import type { Marker } from "../types";
import { MarkerGlyph } from "./markers";

interface BookmarksPanelProps {
  markers: Marker[];
  onJump: (n: number) => void;
  onSetNote: (n: number, note: string) => void;
  onRemove: (n: number) => void;
}

/** The Bookmarks tab body: a jump-list of every marker in the active file. */
export function BookmarksPanel({ markers, onJump, onSetNote, onRemove }: BookmarksPanelProps) {
  if (!markers.length) {
    return (
      <div className="bm-empty">
        <Bookmark size={22} style={{ color: "var(--text-3)", marginBottom: 6 }} />
        <div>No bookmarks yet.</div>
        <div style={{ fontSize: "0.92em" }}>Click a line's gutter (left of the number) to add one.</div>
      </div>
    );
  }
  return (
    <div className="bm-list scroll">
      {markers.map((m) => (
        <div key={m.n} className="bm-row">
          <button className="bm-jump" title="Jump to this line" onClick={() => onJump(m.n)}>
            <span className="bm-ico"><MarkerGlyph icon={m.icon} /></span>
            <span className="bm-line">{m.n}</span>
          </button>
          <input
            className="bm-note"
            placeholder="Add a note…"
            value={m.note}
            onChange={(e) => onSetNote(m.n, e.target.value)}
          />
          <button className="bm-del" title="Remove bookmark" onClick={() => onRemove(m.n)}>
            <Trash2 size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

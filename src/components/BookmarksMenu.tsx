import { useMemo, useState, type CSSProperties } from "react";
import { Bookmark, Plus, Trash2 } from "lucide-react";
import type { Marker, MarkerIcon } from "@/types";
import {
  MARKER_ICONS,
  MarkerGlyph,
  markerColor,
} from "@/components/widgets/markers";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useStore } from "@/store";

interface BookmarksMenuProps {
  /** Bookmarks of this pane's file (already scoped by the caller). */
  markers: Marker[];
  /** Resolves a line number to its raw log text, for the preview line. */
  lineText: (n: number) => string;
  /** Scroll/select a bookmarked line in this pane. Leaves the menu open. */
  onJump: (n: number) => void;
}

/**
 * The header pill that replaces the old Bookmarks dock tab: a bookmark icon with
 * a live count, opening a dropdown that lists every bookmark in this pane's file.
 * The dropdown keeps the panel's icon-filter chips + inline note editing. Jumping
 * leaves it OPEN so you can step through several bookmarks in a row (a jump only
 * scrolls/selects behind the popover — it doesn't steal focus, so it stays put);
 * dismiss with Esc, an outside click, or the pill. Write actions go straight to
 * the store (they target the focused pane's file — opening the menu focuses this
 * pane via the pointer-down capture, so they land on the right log).
 */
export function BookmarksMenu({
  markers,
  lineText,
  onJump,
}: BookmarksMenuProps) {
  const setMarker = useStore((s) => s.setMarker);
  const onRemove = useStore((s) => s.removeMarker);
  const onClearAll = useStore((s) => s.clearMarkers);
  const [open, setOpen] = useState(false);
  // Which row's note is in edit mode; null = all rows show their read state.
  const [editing, setEditing] = useState<number | null>(null);
  // Icon filter: "all" shows every marker, otherwise only the chosen glyph.
  const [filter, setFilter] = useState<MarkerIcon | "all">("all");

  // Count markers per icon so the filter chips can show badges and hide the
  // glyphs that aren't in use.
  const counts = useMemo(() => {
    const c = new Map<MarkerIcon, number>();
    for (const m of markers) c.set(m.icon, (c.get(m.icon) ?? 0) + 1);
    return c;
  }, [markers]);

  // The active filter may point at an icon that no longer exists (last one of
  // its kind removed); fall back to showing everything in that case.
  const effective = filter !== "all" && counts.has(filter) ? filter : "all";
  const shown =
    effective === "all" ? markers : markers.filter((m) => m.icon === effective);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            className={"dock-btn lv-toggle bm-pill" + (open ? " active" : "")}
            title="Bookmarks"
            aria-label={`Bookmarks (${markers.length})`}
          />
        }
      >
        <Bookmark size={14} />
        {markers.length > 0 && (
          <span className="bm-pill-n">{markers.length}</span>
        )}
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end" className="bm-pop">
        {markers.length === 0 ? (
          <div className="bm-pop-empty">
            <Bookmark size={20} />
            <div className="bm-pop-empty-title">No bookmarks yet</div>
            <p>Click a line's gutter (left of the line number) to add one.</p>
          </div>
        ) : (
          <div className="bm-wrap">
            <div className="bm-head">
              <div className="bm-chips scroll">
                <button
                  className={"bm-chip" + (effective === "all" ? " on" : "")}
                  onClick={() => setFilter("all")}
                  title="Show all bookmarks"
                >
                  All <span className="bm-chip-n">{markers.length}</span>
                </button>
                {MARKER_ICONS.filter((mi) => counts.has(mi.id)).map((mi) => (
                  <button
                    key={mi.id}
                    className={"bm-chip" + (effective === mi.id ? " on" : "")}
                    style={{ ["--mk" as string]: mi.color } as CSSProperties}
                    onClick={() =>
                      setFilter(effective === mi.id ? "all" : mi.id)
                    }
                  >
                    <MarkerGlyph icon={mi.id} size={12} />
                    <span className="bm-chip-n">{counts.get(mi.id)}</span>
                  </button>
                ))}
              </div>
              <button
                className="bm-clear"
                onClick={onClearAll}
                title="Remove all bookmarks"
              >
                Clear all
              </button>
            </div>

            <div className="bm-list scroll">
              {shown.map((m) => {
                const text = lineText(m.n);
                const isEditing = editing === m.n;
                const hasNote = m.note.trim().length > 0;
                return (
                  <div
                    key={m.n}
                    className="bm-row"
                    style={
                      {
                        ["--mk" as string]: markerColor(m.icon),
                      } as CSSProperties
                    }
                  >
                    <span className="bm-strip" />
                    <button
                      className="bm-jump"
                      title="Jump to this line"
                      onClick={() => onJump(m.n)}
                    >
                      <span className="bm-ico">
                        <MarkerGlyph icon={m.icon} />
                      </span>
                      <span className="bm-line">{m.n}</span>
                    </button>
                    <div className="bm-content">
                      {isEditing ? (
                        <input
                          className="bm-note"
                          placeholder="Add a note…"
                          value={m.note}
                          autoFocus
                          onChange={(e) =>
                            setMarker(m.n, m.icon, e.target.value)
                          }
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === "Escape")
                              setEditing(null);
                          }}
                          onBlur={() => setEditing(null)}
                        />
                      ) : hasNote ? (
                        <button
                          className="bm-title"
                          title="Edit note"
                          onClick={() => setEditing(m.n)}
                        >
                          {m.note}
                        </button>
                      ) : null}
                      <button
                        className={
                          "bm-preview" + (hasNote || isEditing ? " muted" : "")
                        }
                        title={text ? "Jump to this line" : undefined}
                        onClick={() => onJump(m.n)}
                      >
                        {text || (
                          <span className="bm-noline">(line {m.n})</span>
                        )}
                      </button>
                      {!hasNote && !isEditing && (
                        <button
                          className="bm-addnote"
                          onClick={() => setEditing(m.n)}
                        >
                          <Plus size={12} /> note
                        </button>
                      )}
                    </div>
                    <button
                      className="bm-del"
                      title="Remove bookmark"
                      onClick={() => onRemove(m.n)}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

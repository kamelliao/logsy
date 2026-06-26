import { useRef, useState } from "react";
import { Plus, Tag, X } from "lucide-react";

/**
 * Tag editor for a pack's expanded detail. Aims for a bit of polish over a bare
 * input: chips with a hover-revealed remove, a focus ring on the field, type-
 * ahead suggestions drawn from tags already used elsewhere in the library, paste
 * / Tab / comma to commit several at once, and a small shake when you re-type a
 * tag the pack already has. Empty packs show a compact "+ Tag" pill until clicked.
 */
export function PackTagEditor({
  tags,
  allTags,
  onSetTags,
}: {
  tags: string[];
  /** Every tag in use across the library — powers the type-ahead suggestions. */
  allTags: string[];
  onSetTags: (tags: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(tags.length > 0);
  const [focused, setFocused] = useState(false);
  const [shake, setShake] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const shakeTimer = useRef<number | null>(null);

  const lower = new Set(tags.map((t) => t.toLowerCase()));
  const q = draft.trim().toLowerCase();
  const suggestions = allTags
    .filter(
      (t) => !lower.has(t.toLowerCase()) && (!q || t.toLowerCase().includes(q)),
    )
    .slice(0, 6);

  const flashShake = (tag: string) => {
    setShake(tag);
    if (shakeTimer.current) clearTimeout(shakeTimer.current);
    shakeTimer.current = window.setTimeout(() => setShake(null), 420);
  };

  // Commit raw text (possibly several tags pasted/typed with comma/newline). Adds
  // the new ones; if everything was a duplicate, shake the existing chip instead.
  const commit = (raw: string) => {
    const parts = raw
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!parts.length) return;
    const seen = new Set(tags.map((t) => t.toLowerCase()));
    const fresh: string[] = [];
    let dup: string | null = null;
    for (const p of parts) {
      const key = p.toLowerCase();
      if (seen.has(key)) {
        dup = tags.find((t) => t.toLowerCase() === key) ?? p;
        continue;
      }
      seen.add(key);
      fresh.push(p);
    }
    if (fresh.length) onSetTags([...tags, ...fresh]);
    else if (dup) flashShake(dup);
    setDraft("");
  };

  const removeTag = (t: string) => onSetTags(tags.filter((x) => x !== t));

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === "," || e.key === "Tab") {
      if (draft.trim()) {
        e.preventDefault();
        commit(draft);
      }
    } else if (e.key === "Escape") {
      setDraft("");
      if (!tags.length) setAdding(false);
    }
  };

  // Empty pack, not yet adding: a single inviting pill instead of a bare field.
  if (!adding && tags.length === 0) {
    return (
      <div className="pack-tags-edit">
        <button
          className="pte-addpill"
          onClick={() => {
            setAdding(true);
            requestAnimationFrame(() => inputRef.current?.focus());
          }}
        >
          <Plus size={12} />
          Tag
        </button>
      </div>
    );
  }

  return (
    <div className="pack-tags-edit">
      <span className="pte-ico" title="Tags">
        <Tag size={12} />
      </span>
      {tags.map((t) => (
        <span
          key={t}
          className={"tag-chip removable" + (shake === t ? " shake" : "")}
        >
          {t}
          <button
            className="tc-x"
            title="Remove tag"
            onClick={() => removeTag(t)}
          >
            <X size={11} />
          </button>
        </span>
      ))}
      <div className="pte-field">
        <input
          ref={inputRef}
          className="pte-input"
          placeholder={tags.length ? "Add tag…" : "Add a tag…"}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            // Clicking a suggestion uses onMouseDown+preventDefault, so it keeps
            // focus and doesn't trip this; any other blur closes the dropdown.
            setFocused(false);
            if (draft.trim()) commit(draft);
          }}
        />
        {focused && suggestions.length > 0 && (
          <div className="pte-suggest">
            {suggestions.map((s) => (
              <button
                key={s}
                className="pte-suggest-item"
                // commit before blur so the click isn't swallowed by onBlur
                onMouseDown={(e) => {
                  e.preventDefault();
                  commit(s);
                  inputRef.current?.focus();
                }}
              >
                <Tag size={11} />
                {s}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

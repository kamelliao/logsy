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
  const draftTrim = draft.trim();
  const q = draftTrim.toLowerCase();
  // The dropdown now wraps pills and scrolls, so we no longer need to keep this
  // tight — a generous cap just guards against pathological libraries.
  const suggestions = allTags
    .filter(
      (t) => !lower.has(t.toLowerCase()) && (!q || t.toLowerCase().includes(q)),
    )
    .slice(0, 40);
  // Offer an explicit "create" action whenever the draft is a genuinely new tag.
  // This doubles as the affordance for "press Enter to add": it shows up exactly
  // when typing something the library doesn't have yet (even if the suggestion
  // list is otherwise empty), and the ↵ hint teaches the keyboard shortcut.
  const canCreate =
    draftTrim.length > 0 &&
    !lower.has(q) &&
    !allTags.some((t) => t.toLowerCase() === q);

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
          placeholder={tags.length ? "Add tag…" : "Type a tag, press Enter…"}
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
        {focused && (canCreate || suggestions.length > 0) && (
          <div className="pte-suggest">
            {canCreate && (
              <button
                className="pte-suggest-item pte-create"
                // commit before blur so the click isn't swallowed by onBlur
                onMouseDown={(e) => {
                  e.preventDefault();
                  commit(draft);
                  inputRef.current?.focus();
                }}
              >
                <Plus size={11} />
                <span className="pte-create-label">Create “{draftTrim}”</span>
                <kbd className="pte-kbd">↵</kbd>
              </button>
            )}
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

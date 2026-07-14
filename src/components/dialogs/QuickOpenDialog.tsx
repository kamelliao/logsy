import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { LogFile } from "@/types";
import { FileGlyph } from "@/components/widgets/fileIcons";
import { fuzzyMatch, substringMatch } from "@/lib/fuzzy";
import { useStore } from "@/store";

interface Props {
  files: LogFile[];
  onPick: (id: string) => void;
  onClose: () => void;
}

interface Row {
  file: LogFile;
  score: number;
  /** Matched character positions, in the name and in the path respectively. */
  hits: number[];
  pathHits: number[];
}

/** Name with the fuzzy-matched characters emphasised. */
function Highlight({
  text,
  hits,
}: {
  text: string;
  hits: number[];
}): ReactNode {
  if (!hits.length) return <>{text}</>;
  const set = new Set(hits);
  return (
    <>
      {text.split("").map((ch, i) =>
        set.has(i) ? (
          <b key={i} className="qo-hit">
            {ch}
          </b>
        ) : (
          ch
        ),
      )}
    </>
  );
}

/**
 * Quick Open (Ctrl+P): fuzzy-search the open logs by name or path and jump to one.
 * With no query the list is most-recently-viewed first, so Ctrl+P then Enter is a
 * "back to the last log" toggle. Rendered only while open — it owns its query and
 * autofocuses on mount.
 */
export function QuickOpenDialog({ files, onPick, onClose }: Props): ReactNode {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const mru = useStore((s) => s.fileMru);

  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const rows = useMemo<Row[]>(() => {
    const query = q.trim();
    if (!query) {
      // MRU first, then whatever hasn't been viewed this session, in file order.
      const rank = new Map(mru.map((id, i) => [id, i] as const));
      return [...files]
        .sort(
          (a, b) =>
            (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
            (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER),
        )
        .map((file) => ({ file, score: 0, hits: [], pathHits: [] }));
    }
    const out: Row[] = [];
    for (const file of files) {
      const byName = fuzzyMatch(query, file.name);
      if (byName) {
        // A name hit always beats a path-only hit, whatever either scored.
        out.push({
          file,
          score: byName.score + 10000,
          hits: byName.idx,
          pathHits: [],
        });
        continue;
      }
      // Paths take a substring match only — see substringMatch's note on why a
      // subsequence over a long path is noise.
      const byPath = file.path ? substringMatch(query, file.path) : null;
      if (byPath)
        out.push({ file, score: byPath.score, hits: [], pathHits: byPath.idx });
    }
    return out.sort((a, b) => b.score - a.score);
  }, [q, files, mru]);

  // Any change to the result list puts the caret back on the top hit.
  useEffect(() => setSel(0), [q]);

  // Keep the highlighted row in view while arrowing through a long list.
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(".qo-row.sel")
      ?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const pick = (i: number) => {
    const row = rows[i];
    if (!row) return;
    onPick(row.file.id);
    onClose();
  };

  return (
    <div className="qo-overlay" onMouseDown={onClose}>
      <div className="qo-box" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="qo-input"
          placeholder="Go to file by name or path…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSel((i) => Math.min(i + 1, rows.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSel((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              pick(sel);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
        />
        <div className="qo-list scroll" ref={listRef}>
          {rows.map((r, i) => (
            <div
              key={r.file.id}
              className={"qo-row" + (i === sel ? " sel" : "")}
              onMouseMove={() => setSel(i)}
              onClick={() => pick(i)}
            >
              <span className="qo-ico">
                <FileGlyph icon={r.file.icon} size={15} />
              </span>
              <span className="qo-name">
                <Highlight text={r.file.name} hits={r.hits} />
              </span>
              <span className="qo-path">
                <Highlight text={r.file.path ?? ""} hits={r.pathHits} />
              </span>
              <span className="qo-lines">
                {r.file.lineCount.toLocaleString()}
              </span>
            </div>
          ))}
          {!rows.length && <div className="qo-empty">No matching log</div>}
        </div>
      </div>
    </div>
  );
}

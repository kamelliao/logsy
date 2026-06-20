import { useState, useMemo, useEffect, useRef, useDeferredValue } from "react";
import {
  Asterisk,
  Check,
  ChevronDown,
  ChevronRight,
  EyeOff,
  Parentheses,
  Pipette,
  Trash2,
  Wand2,
  X,
} from "lucide-react";
import type { Filter, FilterGroup, FieldType, PaletteEntry } from "@/types";
import {
  compile,
  scanMatches,
  groupSegments,
  deriveFields,
  escapeRegex,
} from "@/lib/engine";
import {
  tokenize,
  buildPattern,
  assignNames,
  generalPattern,
  mergeTokens,
  splitToken,
  type GenToken,
  type GenState,
} from "@/lib/generalize";
import { reparsePattern } from "@/lib/reparse";
import { TEXT_SWATCHES, BG_SWATCHES } from "@/lib/palette";

/** First line matching `re` (early-exit), or null. Used to dress reconstructed
 *  chips with real sample text when reopening the builder on an existing filter. */
function firstMatchingLine(lines: string[], re: RegExp): string | null {
  for (const l of lines) {
    re.lastIndex = 0;
    if (re.test(l)) return l;
  }
  return null;
}

const FIELD_TYPES: FieldType[] = ["string", "int", "hex", "float", "time"];

// Light default applied to the text color when a dark background is chosen and
// the current text would be illegible against it.
const LIGHT_TEXT = "#e6edf3";
const HEX6 = /^#[0-9a-fA-F]{6}$/;

/** Relative luminance (0 dark … 1 light) of a #rrggbb color; 1 for non-hex. */
function luminance(hex: string): number {
  if (!HEX6.test(hex)) return 1;
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { RegexInput } from "@/components/RegexInput";
import { Label } from "@/components/ui/label";
import { ColorCombobox } from "@/components/ui/color-combobox";
import { GroupCombobox } from "@/components/ui/group-combobox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

function ToggleCard({
  on,
  ex,
  glyph,
  name,
  desc,
  onClick,
}: {
  on: boolean;
  ex?: boolean;
  glyph: React.ReactNode;
  name: string;
  desc: string;
  onClick: () => void;
}) {
  return (
    <div
      className={"toggle-card" + (on ? " on" : "") + (ex ? " ex" : "")}
      onClick={onClick}
    >
      <div className="tc-top">
        <span className="tc-glyph">{glyph}</span>
        <span className="tc-name">{name}</span>
        <span className="tc-check">
          <Check size={16} />
        </span>
      </div>
      <div className="tc-desc">{desc}</div>
    </div>
  );
}

interface EditModalProps {
  filter: Filter;
  lines: string[];
  isNew: boolean;
  groups: FilterGroup[];
  palette: PaletteEntry[];
  /**
   * Raw text the filter was generalized from ("Filter as pattern…" in the log
   * view). When present, a token-chips row lets the user cycle each detected
   * token between exact / generalized / capture; chips rebuild the pattern and
   * disable once the pattern is edited by hand (one-way sync, no regex parsing).
   */
  genSeed?: string;
  onSave: (filter: Filter) => void;
  onClose: () => void;
  onDelete: () => void;
}

export function EditModal({
  filter,
  lines,
  isNew,
  groups,
  palette,
  genSeed,
  onSave,
  onClose,
  onDelete,
}: EditModalProps) {
  const [draft, setDraft] = useState<Filter>({ ...filter });
  // User-chosen types for named groups, keyed by group name (survives regex edits).
  const [fieldTypes, setFieldTypes] = useState<Record<string, FieldType>>(() =>
    Object.fromEntries((filter.fields ?? []).map((f) => [f.name, f.type])),
  );
  // RegexInput is a textarea, the plain-text branch a regular input; both
  // support the focus()/select() this ref is used for.
  const patternRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);

  // Width resize via the left/right edge handles. The modal is centre-anchored,
  // so width changes by 2×dx to keep the dragged edge under the cursor.
  // The chosen width persists across sessions (clamped to the current window).
  const [width, setWidth] = useState<number | null>(() => {
    const w = Number(localStorage.getItem("logsy.editModalWidth"));
    return Number.isFinite(w) && w >= 440
      ? Math.min(w, window.innerWidth - 40)
      : null;
  });
  const resizeRef = useRef<{
    startX: number;
    startW: number;
    side: "left" | "right";
  } | null>(null);
  const onResizeDown =
    (side: "left" | "right") => (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const modal = e.currentTarget.parentElement as HTMLElement;
      resizeRef.current = {
        startX: e.clientX,
        startW: width ?? modal.getBoundingClientRect().width,
        side,
      };
      e.currentTarget.setPointerCapture(e.pointerId);
    };
  const onResizeMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = resizeRef.current;
    if (!r) return;
    const dx = e.clientX - r.startX;
    const raw = r.side === "right" ? r.startW + dx * 2 : r.startW - dx * 2;
    setWidth(Math.max(440, Math.min(window.innerWidth - 40, raw)));
  };
  const onResizeUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!resizeRef.current) return;
    resizeRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    if (width != null)
      localStorage.setItem("logsy.editModalWidth", String(Math.round(width)));
  };

  useEffect(() => {
    patternRef.current?.focus();
    patternRef.current?.select();
  }, []);

  useEffect(() => {
    function key(e: KeyboardEvent) {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
    }
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  });

  const set = (patch: Partial<Filter>) => setDraft((d) => ({ ...d, ...patch }));

  // Choose a background; when switching to a dark one, lighten dark text so the
  // line stays legible. Leaves an already-light text color untouched.
  const pickBg = (color: string) =>
    setDraft((d) =>
      luminance(color) < 0.4 && luminance(d.textColor) < 0.4
        ? { ...d, bgColor: color, textColor: LIGHT_TEXT }
        : { ...d, bgColor: color },
    );

  const compiled = useMemo(
    () => compile(draft),
    [draft.pattern, draft.regex, draft.caseSensitive],
  );

  // The full-file scan runs against a deferred snapshot so typing stays
  // responsive on huge logs; the count/preview lag a beat instead.
  const deferredCompiled = useDeferredValue(compiled);
  const scan = useMemo(
    () =>
      deferredCompiled.ok && deferredCompiled.re
        ? scanMatches(lines, deferredCompiled.re, 100)
        : { count: 0, samples: [] },
    [deferredCompiled, lines],
  );
  // Preview-only recompile with the `d` flag: groupSegments needs match
  // indices to color each named group's span.
  const previewRe = useMemo(() => {
    if (!deferredCompiled.ok || !deferredCompiled.re) return null;
    try {
      return new RegExp(
        deferredCompiled.re.source,
        deferredCompiled.re.flags + "d",
      );
    } catch {
      return null;
    }
  }, [deferredCompiled]);
  const groupOrder = useMemo(
    () =>
      deferredCompiled.f.regex
        ? deriveFields(deferredCompiled.f.pattern).map((f) => f.name)
        : [],
    [deferredCompiled],
  );

  const [previewOpen, setPreviewOpen] = useState(
    () => localStorage.getItem("logsy.matchPreviewOpen") !== "0",
  );
  const togglePreview = () =>
    setPreviewOpen((o) => {
      localStorage.setItem("logsy.matchPreviewOpen", o ? "0" : "1");
      return !o;
    });

  // --- token chips ("Filter as pattern…") ---------------------------------
  // New filters created via "Filter as pattern…" arrive with genSeed. Editing an
  // existing regex filter has no seed, so we reconstruct the chips from its
  // pattern (reparsePattern) and dress them with real text from the first
  // matching line — letting the builder reopen on a filter built earlier. The
  // reconstruction returns null for any pattern outside the builder's grammar
  // (hand-edited or foreign regex), in which case no builder is shown.
  // Mount-once: reading props in a [] useMemo is intentional here.
  const initialGen = useMemo(() => {
    if (genSeed) return { tokens: tokenize(genSeed), built: filter.pattern };
    if (!isNew && filter.regex && filter.pattern.trim()) {
      const c = compile(filter);
      const line = c.ok && c.re ? firstMatchingLine(lines, c.re) : null;
      const tokens = reparsePattern(
        filter.pattern,
        line,
        c.ok && c.re ? c.re.flags : "",
      );
      if (tokens) return { tokens, built: filter.pattern };
    }
    return { tokens: null as GenToken[] | null, built: "" };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [genTokens, setGenTokens] = useState<GenToken[] | null>(
    initialGen.tokens,
  );
  // The last pattern the chips produced; a mismatch means manual edits.
  const lastBuiltRef = useRef(initialGen.built);
  const chipsActive =
    genTokens !== null && draft.pattern === lastBuiltRef.current;
  const chipNames = useMemo(
    () => (genTokens ? assignNames(genTokens) : []),
    [genTokens],
  );
  // When a chip turns into a capture, its name input should grab focus so the
  // user can type the field name straight away. The input only renders once the
  // chip is in "capture" state, so we stash the index here and let the input's
  // ref callback focus itself on mount (then clear the request).
  const focusChipRef = useRef<number | null>(null);

  const applyTokens = (next: GenToken[]) => {
    setGenTokens(next);
    const p = buildPattern(next);
    lastBuiltRef.current = p;
    set({ pattern: p });
  };
  const cycleChip = (i: number) => {
    if (!genTokens) return;
    const t = genTokens[i];
    if (!t || t.kind === "text") return;
    const order: GenState[] =
      t.kind === "ws" ? ["general", "exact"] : ["general", "capture", "exact"];
    const next = order[(order.indexOf(t.state) + 1) % order.length];
    if (next === "capture") focusChipRef.current = i;
    applyTokens(genTokens.map((x, k) => (k === i ? { ...x, state: next } : x)));
  };
  const renameChip = (i: number, name: string) =>
    genTokens &&
    applyTokens(genTokens.map((t, k) => (k === i ? { ...t, name } : t)));
  const setChipState = (i: number, state: GenState) => {
    if (state === "capture") focusChipRef.current = i;
    if (genTokens)
      applyTokens(genTokens.map((t, k) => (k === i ? { ...t, state } : t)));
  };

  // Drag across chips to select a contiguous run; releasing merges it into one
  // chip. A press-and-release on a single chip leaves a===b, so the regular
  // click-to-cycle still fires (click needs down+up on the same element).
  const [dragSel, setDragSel] = useState<{ a: number; b: number } | null>(null);
  useEffect(() => {
    if (!dragSel) return;
    const up = () => {
      setDragSel(null);
      if (genTokens && dragSel.a !== dragSel.b)
        applyTokens(mergeTokens(genTokens, dragSel.a, dragSel.b));
    };
    document.addEventListener("pointerup", up);
    return () => document.removeEventListener("pointerup", up);
  });
  const inDragSel = (i: number) =>
    dragSel !== null &&
    dragSel.a !== dragSel.b &&
    i >= Math.min(dragSel.a, dragSel.b) &&
    i <= Math.max(dragSel.a, dragSel.b);

  // Right-click menu on a chip: pick the state directly (each option shows the
  // regex it emits) and split a merged chip back into its original tokens.
  const [chipMenu, setChipMenu] = useState<{
    i: number;
    anchor: HTMLElement;
  } | null>(null);

  // Wand on a preview row: re-seed the builder from that line. Held here until
  // the user confirms, because applying replaces the current pattern.
  const [pendingSeed, setPendingSeed] = useState<{
    line: number;
    tokens: GenToken[];
    pattern: string;
  } | null>(null);
  const seedFromLine = (line: number, text: string) => {
    const tokens = tokenize(text.trim());
    setPendingSeed({ line, tokens, pattern: buildPattern(tokens) });
  };
  const applyPendingSeed = () => {
    if (!pendingSeed) return;
    setGenTokens(pendingSeed.tokens);
    lastBuiltRef.current = pendingSeed.pattern;
    // Chips emit regex, so seeding implies regex mode.
    set({ pattern: pendingSeed.pattern, regex: true });
    setPendingSeed(null);
  };
  // Bulk-set every non-literal token at once; text tokens have no general form.
  const setAllChips = (state: "general" | "capture") =>
    genTokens &&
    applyTokens(
      genTokens.map((t) => {
        if (t.kind === "text") return t;
        // Whitespace can't be a named group — generalize it instead of capturing.
        if (state === "capture" && t.kind === "ws")
          return { ...t, state: "general" };
        return { ...t, state };
      }),
    );
  // Toolbar disabled state: grey out the button whose target state already holds.
  const generalizable = genTokens?.filter((t) => t.kind !== "text") ?? [];
  const hasCapturable = generalizable.some((t) => t.kind !== "ws");
  const allGeneral = generalizable.every((t) => t.state === "general");
  const allCapture = generalizable.every((t) =>
    t.kind === "ws" ? t.state === "general" : t.state === "capture",
  );

  const valid = compiled.ok && draft.pattern.trim().length > 0;

  // Named groups in the (regex) pattern become structured fields; preserve any
  // type the user already picked for a same-named group.
  const fields = useMemo(() => {
    if (!draft.regex) return [];
    return deriveFields(draft.pattern).map((nf) => ({
      name: nf.name,
      type: fieldTypes[nf.name] ?? nf.type,
    }));
  }, [draft.pattern, draft.regex, fieldTypes]);
  const hasFields = fields.length > 0 && !draft.exclude;

  function save() {
    if (!valid) return;
    onSave({
      ...draft,
      fields: hasFields ? fields : undefined,
    });
  }

  // Has anything actually changed from the filter we opened?
  const dirty = useMemo(() => {
    const current = JSON.stringify({
      ...draft,
      fields: hasFields ? fields : undefined,
    });
    const original = JSON.stringify({ ...filter, fields: filter.fields });
    return current !== original;
  }, [draft, fields, hasFields, filter]);

  const [confirmingClose, setConfirmingClose] = useState(false);
  // Closing with unsaved edits asks for confirmation first.
  function requestClose() {
    if (dirty) setConfirmingClose(true);
    else onClose();
  }

  const selectedPal = palette.find(
    (p) =>
      p.text.toLowerCase() === draft.textColor.toLowerCase() &&
      p.bg.toLowerCase() === draft.bgColor.toLowerCase(),
  );

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) requestClose();
      }}
    >
      <DialogContent
        style={width != null ? { width } : undefined}
        initialFocus={patternRef}
      >
        <div
          className="modal-resize-handle left"
          onPointerDown={onResizeDown("left")}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeUp}
        />
        <div
          className="modal-resize-handle right"
          onPointerDown={onResizeDown("right")}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeUp}
        />
        <DialogHeader>
          <DialogTitle>{isNew ? "New filter" : "Edit filter"}</DialogTitle>
          <Button
            variant="ghost"
            size="icon"
            className="mh-x"
            onClick={requestClose}
          >
            <X size={18} />
          </Button>
        </DialogHeader>

        <div className="modal-body">
          {/* token chips (only for filters created via "Filter as pattern…");
              hidden if the user turns the Regex toggle off, since chips emit regex */}
          {genTokens && draft.regex && (
            <div className="field">
              <div className="pb-head">
                <Label>Pattern builder</Label>
                {chipsActive && generalizable.length > 0 && (
                  <div className="pb-actions">
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      disabled={allCapture || !hasCapturable}
                      title="Capture every field as a named group"
                      onClick={() => setAllChips("capture")}
                    >
                      <Parentheses size={13} />
                    </Button>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      disabled={allGeneral}
                      title="Generalize every token"
                      onClick={() => setAllChips("general")}
                    >
                      <Asterisk size={13} />
                    </Button>
                  </div>
                )}
              </div>
              <div className="pb-hint">
                click a token to cycle: exact → pattern → capture · right-click
                for options · drag across tokens to merge
              </div>
              {/* Manual edits pause the chips rather than hiding them, so the
                  builder stays in place; "Rebuild" overwrites the manual edits. */}
              {!chipsActive && (
                <div className="gen-chips-off">
                  Pattern was edited by hand — the builder is paused.
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => set({ pattern: lastBuiltRef.current })}
                  >
                    Rebuild from chips
                  </Button>
                </div>
              )}
              <div className={"gen-chips" + (chipsActive ? "" : " paused")}>
                {genTokens.map((t, i) => {
                  const isText = t.kind === "text";
                  const clickable = chipsActive && !isText;
                  return (
                    <span
                      key={i}
                      // "lit", not "fixed" — `fixed` is a Tailwind utility
                      // (position: fixed) and would yank the chip out of flow.
                      className={
                        "gen-chip " +
                        t.state +
                        (isText ? " lit" : "") +
                        (inDragSel(i) ? " sel" : "")
                      }
                      title={
                        !chipsActive
                          ? "Builder paused — rebuild from chips to edit"
                          : isText
                            ? "Literal text — drag across tokens to merge"
                            : t.state === "exact"
                              ? `Matches exactly "${t.raw}" — click to generalize`
                              : `Matches ${generalPattern(t)} — click to change`
                      }
                      onClick={clickable ? () => cycleChip(i) : undefined}
                      onPointerDown={
                        chipsActive
                          ? (e) => {
                              if (
                                e.button === 0 &&
                                !(e.target as HTMLElement).closest("input")
                              )
                                setDragSel({ a: i, b: i });
                            }
                          : undefined
                      }
                      onPointerEnter={(e) => {
                        if (dragSel && e.buttons & 1)
                          setDragSel((s) => (s ? { ...s, b: i } : s));
                      }}
                      onContextMenu={
                        chipsActive && (!isText || t.parts)
                          ? (e) => {
                              e.preventDefault();
                              setChipMenu({ i, anchor: e.currentTarget });
                            }
                          : undefined
                      }
                    >
                      <span className="gc-raw">
                        {t.kind === "ws" ? "␣" : t.raw}
                      </span>
                      {t.state === "capture" && (
                        <input
                          className="gc-name"
                          // Auto-focus the name input the moment this chip becomes
                          // a capture (clicking the chip), so the user can name the
                          // field without a second click. Cleared after focusing so
                          // it only fires for the chip that just turned to capture.
                          ref={(el) => {
                            if (el && focusChipRef.current === i) {
                              focusChipRef.current = null;
                              el.focus();
                              el.select();
                            }
                          }}
                          // Bind to the raw user text, not the resolved name, so
                          // the field can be cleared and retyped; the auto name
                          // shows as a placeholder and only lands at build time.
                          value={t.name ?? ""}
                          size={Math.max(
                            2,
                            (t.name || chipNames[i] || "").length,
                          )}
                          placeholder={chipNames[i] ?? ""}
                          title="Field name"
                          disabled={!chipsActive}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) =>
                            renameChip(
                              i,
                              e.target.value.replace(/[^A-Za-z0-9_]/g, ""),
                            )
                          }
                        />
                      )}
                    </span>
                  );
                })}
              </div>
              {chipMenu &&
                genTokens &&
                chipMenu.i < genTokens.length &&
                (() => {
                  const t = genTokens[chipMenu.i];
                  // Resolve the name a capture WOULD get, so the menu can preview
                  // the named-group regex even while the chip isn't a capture yet.
                  const capName =
                    assignNames(
                      genTokens.map((x, k) =>
                        k === chipMenu.i
                          ? { ...x, state: "capture" as GenState }
                          : x,
                      ),
                    )[chipMenu.i] ?? "name";
                  const trunc = (s: string) =>
                    s.length > 30 ? s.slice(0, 29) + "…" : s;
                  const stateItem = (
                    s: GenState,
                    label: string,
                    frag: string,
                  ) => (
                    <DropdownMenuItem
                      onClick={() => setChipState(chipMenu.i, s)}
                    >
                      <span className="mi-ico">
                        {t.state === s ? <Check size={15} /> : null}
                      </span>
                      {label}
                      <code className="mi-frag">{trunc(frag)}</code>
                    </DropdownMenuItem>
                  );
                  return (
                    <DropdownMenu
                      open
                      onOpenChange={(o) => {
                        if (!o) setChipMenu(null);
                      }}
                    >
                      <DropdownMenuContent
                        anchor={chipMenu.anchor}
                        side="bottom"
                        align="start"
                        zIndex={1000}
                      >
                        {stateItem("exact", "Exact text", escapeRegex(t.raw))}
                        {t.kind !== "text" &&
                          stateItem("general", "Pattern", generalPattern(t))}
                        {t.kind !== "text" &&
                          t.kind !== "ws" &&
                          stateItem(
                            "capture",
                            "Capture field",
                            `(?<${capName}>${generalPattern(t)})`,
                          )}
                        {t.parts && (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onClick={() =>
                                applyTokens(splitToken(genTokens, chipMenu.i))
                              }
                            >
                              <span className="mi-ico" />
                              Split into {t.parts.length} tokens
                            </DropdownMenuItem>
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  );
                })()}
            </div>
          )}

          {/* pattern */}
          <div className="field">
            <Label>
              {draft.regex
                ? "Pattern (regular expression)"
                : "Pattern (plain text)"}
            </Label>
            {draft.regex ? (
              <RegexInput
                ref={patternRef as React.Ref<HTMLTextAreaElement>}
                invalid={!compiled.ok}
                value={draft.pattern}
                placeholder="e.g.  ERROR|WARN|fail"
                onChange={(v) => set({ pattern: v })}
              />
            ) : (
              <Input
                ref={patternRef as React.Ref<HTMLInputElement>}
                className={!compiled.ok ? "invalid" : ""}
                value={draft.pattern}
                placeholder="e.g.  wifi"
                onChange={(e) => set({ pattern: e.target.value })}
              />
            )}
            {!compiled.ok ? (
              <div className="regex-err">Invalid regex: {compiled.err}</div>
            ) : !draft.pattern.trim() ? (
              <div className="match-preview">
                Type a pattern to preview matches.
              </div>
            ) : (
              <>
                <button
                  type="button"
                  className="match-preview mp-toggle"
                  onClick={togglePreview}
                >
                  {previewOpen ? (
                    <ChevronDown size={13} />
                  ) : (
                    <ChevronRight size={13} />
                  )}
                  <span>
                    <b>{scan.count.toLocaleString()}</b>
                    {draft.exclude
                      ? " lines will be hidden"
                      : " lines match in this file"}
                  </span>
                </button>
                {previewOpen && (
                  <div className="mp-pane scroll">
                    {scan.samples.length === 0 ? (
                      <div className="mp-empty">No matching lines.</div>
                    ) : (
                      <>
                        {scan.samples.map((s) => (
                          <div className="mp-row" key={s.n}>
                            <button
                              type="button"
                              className="mp-seed"
                              title="Build pattern chips from this line"
                              onClick={() => seedFromLine(s.n, s.text)}
                            >
                              <Wand2 size={12} />
                            </button>
                            <span className="mp-gut">{s.n}</span>
                            <span className="mp-txt">
                              {previewRe
                                ? groupSegments(
                                    s.text,
                                    previewRe,
                                    groupOrder,
                                  ).map((seg, i) =>
                                    seg.hit ? (
                                      <mark
                                        key={i}
                                        className={
                                          "mp-hit" +
                                          (seg.group !== undefined
                                            ? ` g${seg.group % 6}`
                                            : "")
                                        }
                                      >
                                        {seg.t}
                                      </mark>
                                    ) : (
                                      <span key={i}>{seg.t}</span>
                                    ),
                                  )
                                : s.text}
                            </span>
                          </div>
                        ))}
                        {scan.count > scan.samples.length && (
                          <div className="mp-more">
                            Showing the first {scan.samples.length} of{" "}
                            {scan.count.toLocaleString()} matching lines
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}
              </>
            )}
            {pendingSeed && (
              <div className="rebuild-confirm">
                <div className="rc-title">
                  Rebuild the pattern builder from line {pendingSeed.line}?
                </div>
                <div className="rc-row">
                  <span className="rc-tag">current</span>
                  <code>{draft.pattern}</code>
                </div>
                <div className="rc-row">
                  <span className="rc-tag">new</span>
                  <code>{pendingSeed.pattern}</code>
                </div>
                <div className="rc-actions">
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => setPendingSeed(null)}
                  >
                    Cancel
                  </Button>
                  <Button size="xs" onClick={applyPendingSeed}>
                    Replace &amp; edit chips
                  </Button>
                </div>
              </div>
            )}
          </div>

          {/* description */}
          <div className="field">
            <Label>
              Description{" "}
              <span style={{ color: "var(--text-3)", fontWeight: 400 }}>
                (optional)
              </span>
            </Label>
            <Input
              className=""
              style={{ fontFamily: "var(--ui-font)", fontSize: 13.5 }}
              value={draft.description}
              placeholder="What is this filter for?  e.g. PMIC brown-out investigation"
              onChange={(e) => set({ description: e.target.value })}
            />
          </div>

          {/* group */}
          {groups.length > 0 && (
            <div className="field">
              <Label>Group</Label>
              <GroupCombobox
                value={draft.groupId}
                groups={groups}
                onChange={(groupId) => set({ groupId })}
              />
            </div>
          )}

          {/* toggles */}
          <div className="field">
            <Label>Options</Label>
            <div className="toggle-grid">
              <ToggleCard
                on={draft.caseSensitive}
                glyph="Aa"
                name="Case sensitive"
                desc="Match exact letter case"
                onClick={() => set({ caseSensitive: !draft.caseSensitive })}
              />
              <ToggleCard
                on={draft.regex}
                glyph=".*"
                name="Regex"
                desc="Treat pattern as a regular expression"
                onClick={() => set({ regex: !draft.regex })}
              />
              <ToggleCard
                on={draft.exclude}
                ex={draft.exclude}
                glyph={<EyeOff size={14} />}
                name="Exclude"
                desc="Hide matching lines instead of coloring"
                onClick={() => set({ exclude: !draft.exclude })}
              />
            </div>
          </div>

          {/* TODO: parsed fields (named groups) (No use now) */}
          {/* eslint-disable-next-line no-constant-binary-expression */}
          {false && draft.regex && !draft.exclude && fields.length > 0 && (
            <div className="field">
              <Label>
                Parsed fields{" "}
                <span style={{ color: "var(--text-3)", fontWeight: 400 }}>
                  from named groups
                </span>
              </Label>
              <div className="ef-list">
                {fields.map((f, k) => (
                  <div key={f.name} className="ef-row">
                    {/* Same palette index as the group's tint in the pattern + preview. */}
                    <span
                      className="ef-dot"
                      style={{ background: `var(--rxg-${k % 6})` }}
                    />
                    <span className="ef-name">{f.name}</span>
                    <Select
                      value={f.type}
                      onValueChange={(v) =>
                        setFieldTypes((m) => ({
                          ...m,
                          [f.name]: v as FieldType,
                        }))
                      }
                    >
                      <SelectTrigger size="sm" className="w-[96px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {FIELD_TYPES.map((t) => (
                          <SelectItem key={t} value={t}>
                            {t}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* colors */}
          {!draft.exclude && (
            <div className="field">
              <Label>Color</Label>
              <div className="swatches">
                {palette.map((p, i) => (
                  <button
                    key={i}
                    className={"swatch" + (selectedPal === p ? " sel" : "")}
                    style={{ background: p.bg, color: p.text }}
                    title={"Preset: " + p.name}
                    onClick={() => set({ textColor: p.text, bgColor: p.bg })}
                  >
                    <span className="sw-a">A</span>
                  </button>
                ))}
              </div>

              <div className="color-palette">
                <label>Text</label>
                <ColorCombobox
                  value={draft.textColor}
                  options={TEXT_SWATCHES}
                  kind="text"
                  placeholder="Search text color…"
                  onChange={(color) => set({ textColor: color })}
                />
                <label
                  className="swatch swatch-custom"
                  title="Custom text color…"
                >
                  <span
                    className="sw-fill"
                    style={{ background: draft.textColor }}
                  />
                  <Pipette size={13} className="sw-pip" />
                  <input
                    type="color"
                    value={
                      HEX6.test(draft.textColor) ? draft.textColor : "#000000"
                    }
                    onChange={(e) => set({ textColor: e.target.value })}
                  />
                </label>
              </div>

              <div className="color-palette">
                <label>Background</label>
                <ColorCombobox
                  value={draft.bgColor}
                  options={BG_SWATCHES}
                  kind="bg"
                  placeholder="Search background color…"
                  onChange={(color) => pickBg(color)}
                />
                <label
                  className="swatch swatch-custom"
                  title="Custom background color…"
                >
                  <span
                    className="sw-fill"
                    style={{ background: draft.bgColor }}
                  />
                  <Pipette size={13} className="sw-pip" />
                  <input
                    type="color"
                    value={HEX6.test(draft.bgColor) ? draft.bgColor : "#000000"}
                    onChange={(e) => pickBg(e.target.value)}
                  />
                </label>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          {!isNew && (
            <Button variant="destructive" onClick={onDelete}>
              <Trash2 size={15} />
              Delete
            </Button>
          )}
          <div className="spacer" />
          <Button variant="ghost" onClick={requestClose}>
            Cancel
          </Button>
          <Button
            disabled={!valid}
            style={valid ? undefined : { opacity: 0.5, cursor: "not-allowed" }}
            onClick={save}
          >
            {isNew ? "Add filter" : "Save"}
          </Button>
        </DialogFooter>

        {confirmingClose && (
          <div className="modal-confirm">
            <div className="mc-box">
              <div className="mc-title">Discard changes?</div>
              <div className="mc-msg">This filter has unsaved edits.</div>
              <div className="mc-actions">
                <Button
                  variant="ghost"
                  onClick={() => setConfirmingClose(false)}
                >
                  Keep editing
                </Button>
                <Button variant="destructive" onClick={onClose}>
                  Discard
                </Button>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

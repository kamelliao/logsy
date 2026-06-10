import { useState, useMemo, useEffect, useRef, useDeferredValue } from "react";
import { Check, ChevronDown, ChevronRight, EyeOff, Pipette, Trash2, X } from "lucide-react";
import type { Filter, FilterGroup, FieldType } from "../types";
import { compile, scanMatches, groupSegments, deriveFields } from "../logic";
import { tokenize, buildPattern, assignNames, generalPattern, type GenToken, type GenState } from "../lib/generalize";
import { PALETTE, TEXT_SWATCHES, BG_SWATCHES } from "../data";

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
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Input } from "./ui/input";
import { RegexInput } from "./RegexInput";
import { Label } from "./ui/label";
import { ColorCombobox } from "./ui/color-combobox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

function ToggleCard({ on, ex, glyph, name, desc, onClick }: {
  on: boolean; ex?: boolean; glyph: React.ReactNode;
  name: string; desc: string; onClick: () => void;
}) {
  return (
    <div
      className={"toggle-card" + (on ? " on" : "") + (ex ? " ex" : "")}
      onClick={onClick}
    >
      <div className="tc-top">
        <span className="tc-glyph">{glyph}</span>
        <span className="tc-name">{name}</span>
        <span className="tc-check"><Check size={16} /></span>
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

export function EditModal({ filter, lines, isNew, groups, genSeed, onSave, onClose, onDelete }: EditModalProps) {
  const [draft, setDraft] = useState<Filter>({ ...filter });
  // User-chosen types for named groups, keyed by group name (survives regex edits).
  const [fieldTypes, setFieldTypes] = useState<Record<string, FieldType>>(
    () => Object.fromEntries((filter.fields ?? []).map((f) => [f.name, f.type])),
  );
  // RegexInput is a textarea, the plain-text branch a regular input; both
  // support the focus()/select() this ref is used for.
  const patternRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);

  // Width resize via the left/right edge handles. The modal is centre-anchored,
  // so width changes by 2×dx to keep the dragged edge under the cursor.
  const [width, setWidth] = useState<number | null>(null);
  const resizeRef = useRef<{ startX: number; startW: number; side: "left" | "right" } | null>(null);
  const onResizeDown = (side: "left" | "right") => (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault(); e.stopPropagation();
    const modal = e.currentTarget.parentElement as HTMLElement;
    resizeRef.current = { startX: e.clientX, startW: width ?? modal.getBoundingClientRect().width, side };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onResizeMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = resizeRef.current; if (!r) return;
    const dx = e.clientX - r.startX;
    const raw = r.side === "right" ? r.startW + dx * 2 : r.startW - dx * 2;
    setWidth(Math.max(440, Math.min(window.innerWidth - 40, raw)));
  };
  const onResizeUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!resizeRef.current) return;
    resizeRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  };

  useEffect(() => { patternRef.current?.focus(); patternRef.current?.select(); }, []);

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
        : { ...d, bgColor: color }
    );

  const compiled = useMemo(() => compile(draft), [draft.pattern, draft.regex, draft.caseSensitive]);

  // The full-file scan runs against a deferred snapshot so typing stays
  // responsive on huge logs; the count/preview lag a beat instead.
  const deferredCompiled = useDeferredValue(compiled);
  const scan = useMemo(
    () =>
      deferredCompiled.ok && deferredCompiled.re
        ? scanMatches(lines, deferredCompiled.re)
        : { count: 0, samples: [] },
    [deferredCompiled, lines]
  );
  // Preview-only recompile with the `d` flag: groupSegments needs match
  // indices to color each named group's span.
  const previewRe = useMemo(() => {
    if (!deferredCompiled.ok || !deferredCompiled.re) return null;
    try { return new RegExp(deferredCompiled.re.source, deferredCompiled.re.flags + "d"); }
    catch { return null; }
  }, [deferredCompiled]);
  const groupOrder = useMemo(
    () => (deferredCompiled.f.regex ? deriveFields(deferredCompiled.f.pattern).map((f) => f.name) : []),
    [deferredCompiled]
  );

  const [previewOpen, setPreviewOpen] = useState(
    () => localStorage.getItem("logsy.matchPreviewOpen") !== "0"
  );
  const togglePreview = () =>
    setPreviewOpen((o) => { localStorage.setItem("logsy.matchPreviewOpen", o ? "0" : "1"); return !o; });

  // --- token chips ("Filter as pattern…") ---------------------------------
  const [genTokens, setGenTokens] = useState<GenToken[] | null>(() => (genSeed ? tokenize(genSeed) : null));
  // The last pattern the chips produced; a mismatch means manual edits.
  const lastBuiltRef = useRef(genSeed ? filter.pattern : "");
  const chipsActive = genTokens !== null && draft.pattern === lastBuiltRef.current;
  const chipNames = useMemo(() => (genTokens ? assignNames(genTokens) : []), [genTokens]);

  const applyTokens = (next: GenToken[]) => {
    setGenTokens(next);
    const p = buildPattern(next);
    lastBuiltRef.current = p;
    set({ pattern: p });
  };
  const cycleChip = (i: number) =>
    genTokens &&
    applyTokens(genTokens.map((t, k) => {
      if (k !== i || t.kind === "text") return t;
      const order: GenState[] = t.kind === "ws" ? ["general", "exact"] : ["general", "capture", "exact"];
      return { ...t, state: order[(order.indexOf(t.state) + 1) % order.length] };
    }));
  const renameChip = (i: number, name: string) =>
    genTokens && applyTokens(genTokens.map((t, k) => (k === i ? { ...t, name } : t)));

  const valid = compiled.ok && draft.pattern.trim().length > 0;

  // Named groups in the (regex) pattern become structured fields; preserve any
  // type the user already picked for a same-named group.
  const fields = useMemo(() => {
    if (!draft.regex) return [];
    return deriveFields(draft.pattern).map((nf) => ({ name: nf.name, type: fieldTypes[nf.name] ?? nf.type }));
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
    const current = JSON.stringify({ ...draft, fields: hasFields ? fields : undefined });
    const original = JSON.stringify({ ...filter, fields: filter.fields });
    return current !== original;
  }, [draft, fields, hasFields, filter]);

  const [confirmingClose, setConfirmingClose] = useState(false);
  // Closing with unsaved edits asks for confirmation first.
  function requestClose() {
    if (dirty) setConfirmingClose(true);
    else onClose();
  }

  const selectedPal = PALETTE.find(
    (p) => p.text.toLowerCase() === draft.textColor.toLowerCase() && p.bg.toLowerCase() === draft.bgColor.toLowerCase()
  );

  return (
    <Dialog open onOpenChange={(o) => { if (!o) requestClose(); }}>
      <DialogContent style={width != null ? { width } : undefined} initialFocus={patternRef}>
        <div className="modal-resize-handle left" onPointerDown={onResizeDown("left")} onPointerMove={onResizeMove} onPointerUp={onResizeUp} />
        <div className="modal-resize-handle right" onPointerDown={onResizeDown("right")} onPointerMove={onResizeMove} onPointerUp={onResizeUp} />
        <DialogHeader>
          <DialogTitle>{isNew ? "New filter" : "Edit filter"}</DialogTitle>
          <Button variant="ghost" size="icon" className="mh-x" onClick={requestClose}>
            <X size={18} />
          </Button>
        </DialogHeader>

        <div className="modal-body">
          {/* token chips (only for filters created via "Filter as pattern…");
              hidden if the user turns the Regex toggle off, since chips emit regex */}
          {genTokens && draft.regex && (
            <div className="field">
              <Label>
                Pattern builder{" "}
                <span style={{ color: "var(--text-3)", fontWeight: 400 }}>
                  click a token to cycle: exact → pattern → capture
                </span>
              </Label>
              {chipsActive ? (
                <div className="gen-chips">
                  {genTokens.map((t, i) => {
                    const clickable = t.kind !== "text";
                    return (
                      <span
                        key={i}
                        // "lit", not "fixed" — `fixed` is a Tailwind utility
                        // (position: fixed) and would yank the chip out of flow.
                        className={"gen-chip " + t.state + (clickable ? "" : " lit")}
                        title={
                          !clickable ? "Literal text"
                            : t.state === "exact" ? `Matches exactly "${t.raw}" — click to generalize`
                            : `Matches ${generalPattern(t)} — click to change`
                        }
                        onClick={clickable ? () => cycleChip(i) : undefined}
                      >
                        <span className="gc-raw">{t.kind === "ws" ? "␣" : t.raw}</span>
                        {t.state === "capture" && (
                          <input
                            className="gc-name"
                            value={chipNames[i] ?? ""}
                            size={Math.max(2, (chipNames[i] ?? "").length)}
                            title="Field name"
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => renameChip(i, e.target.value.replace(/[^A-Za-z0-9_]/g, ""))}
                          />
                        )}
                      </span>
                    );
                  })}
                </div>
              ) : (
                <div className="gen-chips-off">
                  Pattern edited manually — chips are disabled.
                  <Button size="xs" variant="ghost" onClick={() => set({ pattern: lastBuiltRef.current })}>
                    Restore
                  </Button>
                </div>
              )}
            </div>
          )}

          {/* pattern */}
          <div className="field">
            <Label>{draft.regex ? "Pattern (regular expression)" : "Pattern (plain text)"}</Label>
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
              <div className="match-preview">Type a pattern to preview matches.</div>
            ) : (
              <>
                <button type="button" className="match-preview mp-toggle" onClick={togglePreview}>
                  {previewOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  <span>
                    <b>{scan.count.toLocaleString()}</b>
                    {draft.exclude ? " lines will be hidden" : " lines match in this file"}
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
                            <span className="mp-gut">{s.n}</span>
                            <span className="mp-txt">
                              {previewRe
                                ? groupSegments(s.text, previewRe, groupOrder).map((seg, i) =>
                                    seg.hit ? (
                                      <mark
                                        key={i}
                                        className={"mp-hit" + (seg.group !== undefined ? ` g${seg.group % 6}` : "")}
                                      >
                                        {seg.t}
                                      </mark>
                                    ) : (
                                      <span key={i}>{seg.t}</span>
                                    )
                                  )
                                : s.text}
                            </span>
                          </div>
                        ))}
                        {scan.count > scan.samples.length && (
                          <div className="mp-more">
                            Showing the first {scan.samples.length} of {scan.count.toLocaleString()} matching lines
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}
              </>
            )}
          </div>

          {/* description */}
          <div className="field">
            <Label>Description <span style={{ color: "var(--text-3)", fontWeight: 400 }}>(optional)</span></Label>
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
              <DropdownMenu>
                <DropdownMenuTrigger render={<button type="button" className="section-select" />}>
                  <span className={"ss-label" + (draft.groupId === null ? " placeholder" : "")}>
                    {groups.find((s) => s.id === draft.groupId)?.name ?? "No group (ungrouped)"}
                  </span>
                  <ChevronDown size={15} className="ss-chev" />
                </DropdownMenuTrigger>
                <DropdownMenuContent side="bottom" align="start" zIndex={1000} className="section-select-pop">
                  <DropdownMenuItem onClick={() => set({ groupId: null })}>
                    <span className="mi-ico">{draft.groupId === null ? <Check size={15} /> : null}</span>
                    No group (ungrouped)
                  </DropdownMenuItem>
                  {groups.map((s) => (
                    <DropdownMenuItem key={s.id} onClick={() => set({ groupId: s.id })}>
                      <span className="mi-ico">{draft.groupId === s.id ? <Check size={15} /> : null}</span>
                      {s.name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}

          {/* toggles */}
          <div className="field">
            <Label>Options</Label>
            <div className="toggle-grid">
              <ToggleCard on={draft.caseSensitive} glyph="Aa" name="Case sensitive" desc="Match exact letter case" onClick={() => set({ caseSensitive: !draft.caseSensitive })} />
              <ToggleCard on={draft.regex} glyph=".*" name="Regex" desc="Treat pattern as a regular expression" onClick={() => set({ regex: !draft.regex })} />
              <ToggleCard on={draft.exclude} ex={draft.exclude} glyph={<EyeOff size={14} />} name="Exclude" desc="Hide matching lines instead of coloring" onClick={() => set({ exclude: !draft.exclude })} />
            </div>
          </div>

          {/* TODO: parsed fields (named groups) (No use now) */}
          {false && draft.regex && !draft.exclude && fields.length > 0 && (
            <div className="field">
              <Label>
                Parsed fields{" "}
                <span style={{ color: "var(--text-3)", fontWeight: 400 }}>from named groups</span>
              </Label>
              <div className="ef-list">
                {fields.map((f, k) => (
                  <div key={f.name} className="ef-row">
                    {/* Same palette index as the group's tint in the pattern + preview. */}
                    <span className="ef-dot" style={{ background: `var(--rxg-${k % 6})` }} />
                    <span className="ef-name">{f.name}</span>
                    <Select
                      value={f.type}
                      onValueChange={(v) => setFieldTypes((m) => ({ ...m, [f.name]: v as FieldType }))}
                    >
                      <SelectTrigger size="sm" className="w-[96px]"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {FIELD_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
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
                {PALETTE.map((p) => (
                  <button
                    key={p.name}
                    className={"swatch" + (selectedPal?.name === p.name ? " sel" : "")}
                    style={{ background: p.bg, color: p.text }}
                    title={"Preset: " + p.name}
                    onClick={() => set({ textColor: p.text, bgColor: p.bg })}
                  >
                    {/* "A" previews the text colour over the background; selection shows as the ring. */}
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
                <label className="swatch swatch-custom" title="Custom text color…">
                  <span className="sw-fill" style={{ background: draft.textColor }} />
                  <Pipette size={13} className="sw-pip" />
                  <input
                    type="color"
                    value={HEX6.test(draft.textColor) ? draft.textColor : "#000000"}
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
                <label className="swatch swatch-custom" title="Custom background color…">
                  <span className="sw-fill" style={{ background: draft.bgColor }} />
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
              <Trash2 size={15} />Delete
            </Button>
          )}
          <div className="spacer" />
          <Button variant="ghost" onClick={requestClose}>Cancel</Button>
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
                <Button variant="ghost" onClick={() => setConfirmingClose(false)}>Keep editing</Button>
                <Button variant="destructive" onClick={onClose}>Discard</Button>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

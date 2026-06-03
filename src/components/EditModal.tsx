import { useState, useMemo, useEffect, useRef } from "react";
import { Check, ChevronDown, EyeOff, Trash2, X } from "lucide-react";
import type { Filter, FilterSection, FieldType } from "../types";
import { compile, countMatches, deriveFields } from "../logic";
import { PALETTE, TEXT_SWATCHES, BG_SWATCHES } from "../data";

const FIELD_TYPES: FieldType[] = ["string", "int", "hex", "float", "time"];
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
  sections: FilterSection[];
  onSave: (filter: Filter) => void;
  onClose: () => void;
  onDelete: () => void;
}

export function EditModal({ filter, lines, isNew, sections, onSave, onClose, onDelete }: EditModalProps) {
  const [draft, setDraft] = useState<Filter>({ ...filter });
  // User-chosen types for named groups, keyed by group name (survives regex edits).
  const [fieldTypes, setFieldTypes] = useState<Record<string, FieldType>>(
    () => Object.fromEntries((filter.fields ?? []).map((f) => [f.name, f.type])),
  );
  const [extractOnly, setExtractOnly] = useState<boolean>(!!filter.extractOnly);
  const patternRef = useRef<HTMLInputElement>(null);

  useEffect(() => { patternRef.current?.focus(); patternRef.current?.select(); }, []);

  useEffect(() => {
    function key(e: KeyboardEvent) {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
    }
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  });

  const set = (patch: Partial<Filter>) => setDraft((d) => ({ ...d, ...patch }));

  const compiled = useMemo(() => compile(draft), [draft.pattern, draft.regex, draft.caseSensitive]);
  const matchCount = useMemo(
    () => (compiled.ok && compiled.re ? countMatches(lines, compiled.re) : 0),
    [compiled, lines]
  );

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
      extractOnly: hasFields ? extractOnly : false,
    });
  }

  // Has anything actually changed from the filter we opened?
  const dirty = useMemo(() => {
    const current = JSON.stringify({ ...draft, fields: hasFields ? fields : undefined, extractOnly: hasFields ? extractOnly : false });
    const original = JSON.stringify({ ...filter, fields: filter.fields, extractOnly: filter.extractOnly ?? false });
    return current !== original;
  }, [draft, fields, extractOnly, hasFields, filter]);

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
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isNew ? "New filter" : "Edit filter"}</DialogTitle>
          <Button variant="ghost" size="icon" className="mh-x" onClick={requestClose}>
            <X size={18} />
          </Button>
        </DialogHeader>

        <div className="modal-body">
          {/* pattern */}
          <div className="field">
            <Label>{draft.regex ? "Pattern (regular expression)" : "Pattern (plain text)"}</Label>
            {draft.regex ? (
              <RegexInput
                ref={patternRef}
                invalid={!compiled.ok}
                value={draft.pattern}
                placeholder="e.g.  ERROR|WARN|fail"
                onChange={(v) => set({ pattern: v })}
              />
            ) : (
              <Input
                ref={patternRef}
                className={!compiled.ok ? "invalid" : ""}
                value={draft.pattern}
                placeholder="e.g.  wifi"
                onChange={(e) => set({ pattern: e.target.value })}
              />
            )}
            {!compiled.ok ? (
              <div className="regex-err">Invalid regex: {compiled.err}</div>
            ) : (
              <div className="match-preview">
                {draft.pattern.trim()
                  ? <><b>{matchCount.toLocaleString()}</b>{draft.exclude ? " lines will be hidden" : " lines match in this file"}</>
                  : "Type a pattern to preview matches."}
              </div>
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
          {sections.length > 0 && (
            <div className="field">
              <Label>Group</Label>
              <DropdownMenu>
                <DropdownMenuTrigger render={<button type="button" className="section-select" />}>
                  <span className={"ss-label" + (draft.sectionId === null ? " placeholder" : "")}>
                    {sections.find((s) => s.id === draft.sectionId)?.name ?? "No group (ungrouped)"}
                  </span>
                  <ChevronDown size={15} className="ss-chev" />
                </DropdownMenuTrigger>
                <DropdownMenuContent side="bottom" align="start" zIndex={1000} className="section-select-pop">
                  <DropdownMenuItem onClick={() => set({ sectionId: null })}>
                    <span className="mi-ico">{draft.sectionId === null ? <Check size={15} /> : null}</span>
                    No group (ungrouped)
                  </DropdownMenuItem>
                  {sections.map((s) => (
                    <DropdownMenuItem key={s.id} onClick={() => set({ sectionId: s.id })}>
                      <span className="mi-ico">{draft.sectionId === s.id ? <Check size={15} /> : null}</span>
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

          {/* parsed fields (named groups) */}
          {draft.regex && !draft.exclude && fields.length > 0 && (
            <div className="field">
              <Label>
                Parsed fields{" "}
                <span style={{ color: "var(--text-3)", fontWeight: 400 }}>from named groups</span>
              </Label>
              <div className="ef-list">
                {fields.map((f) => (
                  <div key={f.name} className="ef-row">
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
              <div style={{ marginTop: 9 }}>
                <ToggleCard
                  on={extractOnly}
                  glyph="{ }"
                  name="Extract only"
                  desc="Parse these fields but don't colour matching lines"
                  onClick={() => setExtractOnly(!extractOnly)}
                />
              </div>
            </div>
          )}

          {/* colors */}
          {!draft.exclude && !extractOnly && (
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
                    {selectedPal?.name === p.name && <Check size={15} />}
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
              </div>

              <div className="color-palette">
                <label>Background</label>
                <ColorCombobox
                  value={draft.bgColor}
                  options={BG_SWATCHES}
                  kind="bg"
                  placeholder="Search background color…"
                  onChange={(color) => set({ bgColor: color })}
                />
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

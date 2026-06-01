import { useState, useMemo, useEffect } from "react";
import { ChevronDown, ChevronUp, Plus, Trash2, X } from "lucide-react";
import type { FieldType, ParseProfile } from "../types";
import { coerceValue, deriveFields } from "../logic";
import { makeLinePattern } from "../data";
import { Button } from "./ui/button";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

const FIELD_TYPES: FieldType[] = ["string", "int", "hex", "float", "time"];

interface ProfileModalProps {
  profile: ParseProfile;
  sampleLines: string[];
  onSave: (profile: ParseProfile) => void;
  onClose: () => void;
}

export function ProfileModal({ profile, sampleLines, onSave, onClose }: ProfileModalProps) {
  const [draft, setDraft] = useState<ParseProfile>(() => structuredClone(profile));
  const [selectedId, setSelectedId] = useState<string>(profile.patterns[0]?.id ?? "");
  const samples = useMemo(
    () => sampleLines.filter((l) => l.trim().length).slice(0, 50),
    [sampleLines],
  );
  const [sample, setSample] = useState<string>(samples[0] ?? "");

  const patch = (fn: (d: ParseProfile) => void) =>
    setDraft((d) => { const n = structuredClone(d); fn(n); return n; });

  const selected = draft.patterns.find((p) => p.id === selectedId) ?? draft.patterns[0] ?? null;

  useEffect(() => {
    function key(e: KeyboardEvent) {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onSave(draft);
    }
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [draft, onSave]);

  function addPattern() {
    const p = makeLinePattern("");
    patch((d) => { d.patterns.push(p); });
    setSelectedId(p.id);
  }

  function deletePattern(id: string) {
    const idx = draft.patterns.findIndex((p) => p.id === id);
    patch((d) => { d.patterns = d.patterns.filter((p) => p.id !== id); });
    if (selectedId === id) {
      const next = draft.patterns[idx + 1] ?? draft.patterns[idx - 1];
      setSelectedId(next?.id ?? "");
    }
  }

  function movePattern(id: string, dir: -1 | 1) {
    patch((d) => {
      const i = d.patterns.findIndex((p) => p.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= d.patterns.length) return;
      [d.patterns[i], d.patterns[j]] = [d.patterns[j], d.patterns[i]];
    });
  }

  // Re-derive fields from the new regex, keeping any type the user already chose.
  function setRegex(id: string, regex: string) {
    patch((d) => {
      const p = d.patterns.find((x) => x.id === id);
      if (!p) return;
      p.regex = regex;
      p.fields = deriveFields(regex).map((nf) => {
        const prev = p.fields.find((f) => f.name === nf.name);
        return prev ? { name: nf.name, type: prev.type } : nf;
      });
    });
  }

  function setFieldType(id: string, name: string, type: FieldType) {
    patch((d) => {
      const f = d.patterns.find((x) => x.id === id)?.fields.find((f) => f.name === name);
      if (f) f.type = type;
    });
  }

  function toggleEnabled(id: string) {
    patch((d) => {
      const p = d.patterns.find((x) => x.id === id);
      if (p) p.enabled = !p.enabled;
    });
  }

  const preview = useMemo(() => {
    if (!selected) return null;
    if (!selected.regex.trim()) return { state: "empty" as const };
    let re: RegExp;
    try { re = new RegExp(selected.regex); }
    catch (e) { return { state: "error" as const, err: (e as Error).message }; }
    const m = re.exec(sample);
    if (!m) return { state: "nomatch" as const };
    const groups = m.groups ?? {};
    const rows = selected.fields.map((f) => {
      const raw = groups[f.name];
      return {
        name: f.name, type: f.type,
        raw: raw ?? "",
        value: raw === undefined ? "" : String(coerceValue(raw, f.type)),
        missing: raw === undefined,
      };
    });
    return { state: "match" as const, rows };
  }, [selected, sample]);

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="pm-dialog">
        <DialogHeader>
          <DialogTitle>Parse profile</DialogTitle>
          <DialogClose render={<Button size="icon" className="mh-x" />}>
            <X size={18} />
          </DialogClose>
        </DialogHeader>

        <div className="modal-body">
          {/* name */}
          <div className="field">
            <Label>Profile name</Label>
            <Input
              value={draft.name}
              placeholder="e.g.  Kernel UART"
              onChange={(e) => patch((d) => { d.name = e.target.value; })}
            />
          </div>

          {/* patterns */}
          <div className="field">
            <Label>Line patterns <span style={{ color: "var(--text-3)", fontWeight: 400 }}>(tried top-down; first match wins)</span></Label>
            <div className="pm-pattern-list">
              {draft.patterns.map((p, i) => (
                <div
                  key={p.id}
                  className={"pm-pattern" + (p.id === selected?.id ? " sel" : "") + (p.enabled ? "" : " off")}
                  onClick={() => setSelectedId(p.id)}
                >
                  <input
                    type="checkbox"
                    className="pm-enable"
                    checked={p.enabled}
                    title={p.enabled ? "Enabled" : "Disabled"}
                    onChange={() => toggleEnabled(p.id)}
                    onClick={(e) => e.stopPropagation()}
                  />
                  <input
                    className="pm-regex"
                    spellCheck={false}
                    value={p.regex}
                    placeholder="(?<ts>\d+\.\d+)\s+(?<lvl>[EWID])\s+(?<msg>.*)"
                    onChange={(e) => setRegex(p.id, e.target.value)}
                    onFocus={() => setSelectedId(p.id)}
                  />
                  <button className="pm-ico" title="Move up" disabled={i === 0}
                    onClick={(e) => { e.stopPropagation(); movePattern(p.id, -1); }}>
                    <ChevronUp size={14} />
                  </button>
                  <button className="pm-ico" title="Move down" disabled={i === draft.patterns.length - 1}
                    onClick={(e) => { e.stopPropagation(); movePattern(p.id, 1); }}>
                    <ChevronDown size={14} />
                  </button>
                  <button className="pm-ico danger" title="Delete pattern"
                    onClick={(e) => { e.stopPropagation(); deletePattern(p.id); }}>
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
            <Button variant="ghost" size="sm" className="pm-add" onClick={addPattern}>
              <Plus size={14} /> Add pattern
            </Button>
          </div>

          {/* sample + preview */}
          <div className="field">
            <Label>Test against a sample line</Label>
            {samples.length > 0 && (
              <select
                className="pm-sample-pick"
                value={samples.includes(sample) ? sample : ""}
                onChange={(e) => setSample(e.target.value)}
              >
                <option value="">— pick a line from the log —</option>
                {samples.map((l, i) => (
                  <option key={i} value={l}>{l.length > 90 ? l.slice(0, 90) + "…" : l}</option>
                ))}
              </select>
            )}
            <Input
              className="pm-sample"
              style={{ fontFamily: "var(--mono-font)", fontSize: 12.5 }}
              value={sample}
              placeholder="Paste or pick a representative log line…"
              onChange={(e) => setSample(e.target.value)}
            />

            <div className="pm-preview">
              {!selected ? (
                <div className="pm-hint">Add a pattern to begin.</div>
              ) : preview?.state === "empty" ? (
                <div className="pm-hint">Enter a regex with named groups, e.g. <code>(?&lt;ts&gt;\d+)</code>.</div>
              ) : preview?.state === "error" ? (
                <div className="regex-err">Invalid regex: {preview.err}</div>
              ) : preview?.state === "nomatch" ? (
                <div className="pm-hint warn">This pattern does not match the sample line.</div>
              ) : preview?.state === "match" && preview.rows.length === 0 ? (
                <div className="pm-hint">Matches, but defines no named groups yet.</div>
              ) : preview?.state === "match" ? (
                <table className="pm-fields">
                  <thead>
                    <tr><th>Field</th><th>Type</th><th>Raw</th><th>Parsed</th></tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((r) => (
                      <tr key={r.name} className={r.missing ? "missing" : ""}>
                        <td className="pm-fname">{r.name}</td>
                        <td>
                          <select
                            className="pm-type"
                            value={r.type}
                            onChange={(e) => selected && setFieldType(selected.id, r.name, e.target.value as FieldType)}
                          >
                            {FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                          </select>
                        </td>
                        <td className="pm-raw">{r.missing ? "—" : r.raw}</td>
                        <td className="pm-val">{r.missing ? "—" : r.value}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
            </div>
          </div>
        </div>

        <DialogFooter>
          <div className="spacer" />
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => onSave(draft)}>Save profile</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

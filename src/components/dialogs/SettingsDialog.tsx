import { useState, type ReactNode } from "react";
import {
  ChartGantt,
  Filter as FilterIcon,
  Map as MapIcon,
  Minus,
  Monitor,
  Palette,
  Plus,
  X,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { PaletteEditor } from "@/components/dialogs/PaletteEditor";
import { useStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { FONT_DEFAULT } from "@/config";
import { DEFAULT_PALETTE } from "@/lib/palette";
import type { AppState } from "@/types";

interface SettingsDialogProps {
  onClose: () => void;
}

const CATEGORIES = [
  { id: "appearance", label: "Appearance", Icon: Monitor },
  { id: "minimap", label: "Minimap", Icon: MapIcon },
  { id: "filters", label: "Filters", Icon: FilterIcon },
  { id: "timeline", label: "Timeline", Icon: ChartGantt },
  { id: "colors", label: "Colors", Icon: Palette },
] as const;
type CatId = (typeof CATEGORIES)[number]["id"];

/**
 * Values "Reset to defaults" writes — mirrors `initialState()` plus the same
 * fallbacks the individual controls use, so a reset lands exactly where a fresh
 * workspace starts. Only the keys this dialog manages are touched.
 */
const DEFAULTS = {
  panelPos: "right",
  fontSize: FONT_DEFAULT,
  fontWeight: 400,
  showLineNumbers: true,
  mapColorMode: "bg",
  mapWidth: 16,
  filterLabel: "desc-first",
  timelineIconSize: "M",
} satisfies Partial<AppState>;

/** A segmented single-choice control, reusing the global `.seg` styling. */
function Seg<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { label: string; value: T; title?: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button
          key={String(o.value)}
          title={o.title}
          className={value === o.value ? "on" : ""}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** One setting: a title + one-line description on the left, its control right. */
function Row({
  title,
  desc,
  children,
}: {
  title: string;
  desc: string;
  children: ReactNode;
}) {
  return (
    <div className="set-row">
      <div className="set-row-main">
        <div className="set-row-title">{title}</div>
        <div className="set-row-desc">{desc}</div>
      </div>
      <div className="set-row-control">{children}</div>
    </div>
  );
}

export function SettingsDialog({ onClose }: SettingsDialogProps) {
  const [cat, setCat] = useState<CatId>("appearance");
  const doc = useStore((s) => s.doc);
  const { setDoc, zoomIn, zoomOut, zoomReset } = useStore(
    useShallow((s) => ({
      setDoc: s.setDoc,
      zoomIn: s.zoomIn,
      zoomOut: s.zoomOut,
      zoomReset: s.zoomReset,
    })),
  );
  // Global prefs are plain, non-undoable doc writes (like the old popover).
  const patch = (p: Partial<AppState>) => setDoc((s) => ({ ...s, ...p }));

  const panelPos = doc.panelPos ?? "right";
  const fontSize = doc.fontSize ?? FONT_DEFAULT;
  const fontWeight = doc.fontWeight ?? 400;
  const showLineNumbers = doc.showLineNumbers ?? true;
  const mapColorMode = doc.mapColorMode ?? "bg";
  const mapWidth = doc.mapWidth ?? 16;
  const filterLabel = doc.filterLabel ?? "desc-first";
  const timelineIconSize = doc.timelineIconSize ?? "M";
  const palette = doc.customPalette ?? DEFAULT_PALETTE;

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="settings-dialog" style={{ width: 660 }}>
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <Button
            variant="ghost"
            size="icon"
            className="mh-x"
            onClick={onClose}
          >
            <X size={18} />
          </Button>
        </DialogHeader>

        <div className="settings-layout">
          <nav className="settings-nav">
            {CATEGORIES.map(({ id, label, Icon }) => (
              <button
                key={id}
                className={"settings-nav-item" + (cat === id ? " on" : "")}
                onClick={() => setCat(id)}
              >
                <Icon size={15} />
                <span>{label}</span>
              </button>
            ))}
          </nav>

          <div className="settings-panel scroll">
            {cat === "appearance" && (
              <>
                <Row
                  title="Filter panel position"
                  desc="Where the filter, compare and timeline panel docks."
                >
                  <Seg
                    value={panelPos}
                    onChange={(v) => patch({ panelPos: v })}
                    options={[
                      { label: "Bottom", value: "bottom" },
                      { label: "Right", value: "right" },
                    ]}
                  />
                </Row>
                <Row
                  title="Log font size"
                  desc="Text size in the log view. Also Ctrl +/− or Ctrl+scroll."
                >
                  <div className="set-stepper">
                    <button onClick={zoomOut} title="Smaller">
                      <Minus size={14} />
                    </button>
                    <span className="set-stepper-val">{fontSize}px</span>
                    <button onClick={zoomIn} title="Larger">
                      <Plus size={14} />
                    </button>
                    <button className="set-linkbtn" onClick={zoomReset}>
                      Reset
                    </button>
                  </div>
                </Row>
                <Row
                  title="Log font weight"
                  desc="Stroke weight of the log text."
                >
                  <Seg
                    value={fontWeight}
                    onChange={(v) => patch({ fontWeight: v })}
                    options={[
                      { label: "Light", value: 300 },
                      { label: "Regular", value: 400 },
                      { label: "Medium", value: 500 },
                    ]}
                  />
                </Row>
                <Row
                  title="Line numbers"
                  desc="Show the line-number gutter (and include numbers when copying lines)."
                >
                  <Seg
                    value={showLineNumbers ? "on" : "off"}
                    onChange={(v) => patch({ showLineNumbers: v === "on" })}
                    options={[
                      { label: "On", value: "on" },
                      { label: "Off", value: "off" },
                    ]}
                  />
                </Row>
              </>
            )}

            {cat === "minimap" && (
              <>
                <Row
                  title="Match colour"
                  desc="Paint each match on the minimap by its background or its text colour."
                >
                  <Seg
                    value={mapColorMode}
                    onChange={(v) => patch({ mapColorMode: v })}
                    options={[
                      { label: "Background", value: "bg" },
                      { label: "Text", value: "text" },
                    ]}
                  />
                </Row>
                <Row title="Width" desc="Thickness of the minimap strip.">
                  <Seg
                    value={mapWidth}
                    onChange={(v) => patch({ mapWidth: v })}
                    options={[
                      { label: "S", value: 12 },
                      { label: "M", value: 16 },
                      { label: "L", value: 20 },
                    ]}
                  />
                </Row>
              </>
            )}

            {cat === "filters" && (
              <Row
                title="Filter row label"
                desc="What each filter row shows: its regex, its description, or the description with a regex fallback."
              >
                <Seg
                  value={filterLabel}
                  onChange={(v) => patch({ filterLabel: v })}
                  options={[
                    {
                      label: "Pattern",
                      value: "pattern",
                      title: "Always show the regex pattern",
                    },
                    {
                      label: "Description",
                      value: "description",
                      title: "Always show the description",
                    },
                    {
                      label: "Auto",
                      value: "desc-first",
                      title:
                        "Show the description if set, otherwise the pattern",
                    },
                  ]}
                />
              </Row>
            )}

            {cat === "timeline" && (
              <Row
                title="Event icon size"
                desc="Size of the point and span markers drawn on the timeline."
              >
                <Seg
                  value={timelineIconSize}
                  onChange={(v) => patch({ timelineIconSize: v })}
                  options={[
                    { label: "S", value: "S" },
                    { label: "M", value: "M" },
                    { label: "L", value: "L" },
                  ]}
                />
              </Row>
            )}

            {cat === "colors" && (
              <PaletteEditor
                palette={palette}
                onChange={(p) => patch({ customPalette: p })}
              />
            )}
          </div>
        </div>

        <div className="settings-foot">
          <button
            className="set-linkbtn"
            onClick={() => patch(DEFAULTS)}
            title="Reset every setting in this dialog to its default"
          >
            Reset to defaults
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

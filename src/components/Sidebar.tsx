import { useEffect, useState } from "react";
import { FilePlus, FileText, PanelLeft, Settings, X } from "lucide-react";
import type { AppState, LogFile } from "../types";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

interface FileItemProps {
  file: LogFile;
  active: boolean;
  canDelete: boolean;
  collapsed: boolean;
  onSelect: () => void;
  onDelete: () => void;
}

function FileItem({ file, active, canDelete, collapsed, onSelect, onDelete }: FileItemProps) {
  // Right-click context menu, anchored at the cursor.
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!menu) return;
    function down(e: MouseEvent) {
      if (!(e.target as HTMLElement).closest(".file-menu")) setMenu(null);
    }
    function esc(e: KeyboardEvent) { if (e.key === "Escape") setMenu(null); }
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", esc); };
  }, [menu]);

  return (
    <>
      <Tooltip>
        <TooltipTrigger render={
          <div
            className={"file-item" + (active ? " active" : "")}
            onClick={onSelect}
            onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); }}
          />
        }>
          <span className="file-ico"><FileText size={16} /></span>
          <span className="file-name">{file.name}</span>
          <span className="file-lines">{file.lineCount.toLocaleString()}</span>
          {canDelete && (
            <button
              className="file-x"
              title="Close file"
              onClick={(e) => { e.stopPropagation(); onDelete(); }}
            >
              <X size={13} />
            </button>
          )}
        </TooltipTrigger>
        <TooltipContent side={collapsed ? "right" : "top"}>{file.name}</TooltipContent>
      </Tooltip>

      {menu && (
        <div className="menu-pop file-menu" style={{ position: "fixed", left: menu.x, top: menu.y, zIndex: 200 }}>
          <div
            className="menu-item danger"
            onClick={() => { setMenu(null); onDelete(); }}
          >
            <span className="mi-ico"><X size={14} /></span> Close file
          </div>
        </div>
      )}
    </>
  );
}

interface SidebarProps {
  state: AppState;
  collapsed: boolean;
  /** When the center is showing the "open a file" screen, no file is active. */
  openScreen: boolean;
  onToggleCollapse: () => void;
  onSelectFile: (id: string) => void;
  onOpenFile: () => void;
  onDeleteFile: (id: string) => void;
  onSetPanelPos: (pos: "bottom" | "right") => void;
  onSetMapColorMode: (mode: "bg" | "text") => void;
  onSetMapWidth: (w: number) => void;
  onSetFontWeight: (w: number) => void;
}

export function Sidebar({
  state, collapsed, openScreen, onToggleCollapse, onSelectFile,
  onOpenFile, onDeleteFile,
  onSetPanelPos, onSetMapColorMode, onSetMapWidth, onSetFontWeight,
}: SidebarProps) {
  return (
    <div className={"sidebar" + (collapsed ? " collapsed" : "")}>
      <div className="sidebar-top">
        <Button
          variant="ghost"
          size="icon"
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={onToggleCollapse}
        >
          <PanelLeft size={18} />
        </Button>
      </div>
      <div className="file-list scroll">
        {state.files.map((f) => (
          <FileItem
            key={f.id}
            file={f}
            active={!openScreen && f.id === state.activeFileId}
            canDelete={true}
            collapsed={collapsed}
            onSelect={() => onSelectFile(f.id)}
            onDelete={() => onDeleteFile(f.id)}
          />
        ))}
        <div className="new-tab" onClick={onOpenFile} title="Open a log file (Ctrl O)">
          <FilePlus size={16} />
          <span>Open File</span>
        </div>
      </div>
      <div className="sidebar-bottom">
        <Popover>
          <PopoverTrigger render={
            <div className="settings-row" role="button">
              <Settings size={16} />
              <span>Settings</span>
              {!collapsed && <span className="gear" />}
            </div>
          } />
          <PopoverContent>
            <div style={{ fontWeight: 600, fontSize: 13, padding: "2px 4px 6px" }}>Settings</div>
            <div className="sp-row">
              Filter panel
              <div className="seg" style={{ marginLeft: 8 }}>
                <button className={(state.panelPos ?? "bottom") === "bottom" ? "on" : ""} onClick={() => onSetPanelPos("bottom")}>Bottom</button>
                <button className={(state.panelPos ?? "bottom") === "right" ? "on" : ""} onClick={() => onSetPanelPos("right")}>Right</button>
              </div>
            </div>
            <div className="sp-row">
              Theme
              <span style={{ color: "var(--text-3)" }}>Light</span>
            </div>
            <div className="sp-row">
              Match map color
              <div className="seg" style={{ marginLeft: 8 }}>
                <button className={(state.mapColorMode ?? "bg") === "bg" ? "on" : ""} onClick={() => onSetMapColorMode("bg")}>BG</button>
                <button className={(state.mapColorMode ?? "bg") === "text" ? "on" : ""} onClick={() => onSetMapColorMode("text")}>Text</button>
              </div>
            </div>
            <div className="sp-row">
              Match map width
              <div className="seg" style={{ marginLeft: 8 }}>
                {[{ label: "S", value: 12 }, { label: "M", value: 16 }, { label: "L", value: 20 }].map(({ label, value }) => (
                  <button key={label} className={(state.mapWidth ?? 20) === value ? "on" : ""} onClick={() => onSetMapWidth(value)}>{label}</button>
                ))}
              </div>
            </div>
            <div className="sp-row">
              Log font weight
              <div className="seg" style={{ marginLeft: 8 }}>
                {[{ label: "Light", value: 300 }, { label: "Regular", value: 400 }, { label: "Medium", value: 500 }].map(({ label, value }) => (
                  <button key={label} className={(state.fontWeight ?? 400) === value ? "on" : ""} onClick={() => onSetFontWeight(value)}>{label}</button>
                ))}
              </div>
            </div>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}

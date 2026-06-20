import { Minus, Square, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import type { ReactNode } from "react";
import { APP_NAME } from "@/config";

interface OpenMenu {
  name: string;
  x: number;
  y: number;
}

interface Props {
  menus: readonly string[];
  openMenu: OpenMenu | null;
  setOpenMenu: (m: OpenMenu | null) => void;
}

/**
 * The custom window title bar: brand, the top-level menubar (which opens menus
 * via MenuPopup, driven from App's openMenu state), and the min/max/close
 * window controls. `data-tauri-drag-region` makes the empty areas draggable.
 */
export function Titlebar({ menus, openMenu, setOpenMenu }: Props): ReactNode {
  return (
    <div className="titlebar" data-tauri-drag-region>
      <div className="brand">{APP_NAME}</div>
      <div className="menubar">
        {menus.map((m) => (
          <div
            key={m}
            data-menu={m}
            className={"menu" + (openMenu?.name === m ? " active" : "")}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              setOpenMenu(
                openMenu?.name === m
                  ? null
                  : { name: m, x: rect.left, y: rect.bottom },
              );
            }}
            // Once any menu is open, hovering a sibling switches to it
            // (standard menubar behaviour — no extra click needed).
            onMouseEnter={(e) => {
              if (!openMenu || openMenu.name === m) return;
              const rect = e.currentTarget.getBoundingClientRect();
              setOpenMenu({ name: m, x: rect.left, y: rect.bottom });
            }}
          >
            {m}
          </div>
        ))}
      </div>
      <div className="win-controls" onMouseDown={(e) => e.stopPropagation()}>
        <div
          className="wc"
          onClick={() => invoke("window_controls", { action: "minimize" })}
        >
          <Minus size={15} />
        </div>
        <div
          className="wc"
          onClick={() => invoke("window_controls", { action: "maximize" })}
        >
          <Square size={13} />
        </div>
        <div
          className="wc close"
          onClick={() => invoke("window_controls", { action: "close" })}
        >
          <X size={15} />
        </div>
      </div>
    </div>
  );
}

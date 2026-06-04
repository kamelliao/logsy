import { useState } from "react";
import { Check, ChevronRight } from "lucide-react";

export type MenuItem = {
  label?: string;
  key?: string;
  action?: () => void;
  sep?: true;
  /** When defined the item is a toggle: a check shows on the left while true. */
  checked?: boolean;
  disabled?: boolean;
  /** Nested items shown on hover (one level deep). */
  submenu?: MenuItem[];
};

interface MenuPopupProps {
  items: MenuItem[];
  x: number;
  y: number;
  onClose: () => void;
}

/** A floating menu list with hover submenus, toggle indicators and disabled rows. */
export function MenuPopup({ items, x, y, onClose }: MenuPopupProps) {
  const [sub, setSub] = useState<{ i: number; x: number; y: number } | null>(null);
  // Reserve a left check column for every row when the list contains any toggle,
  // so labels stay aligned whether or not a given row is checkable.
  const hasChecks = items.some((it) => it.checked !== undefined);

  return (
    <div
      className="menu-pop"
      style={{ position: "fixed", left: x, top: y, zIndex: 500 }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {items.map((item, i) =>
        item.sep ? (
          <div key={i} className="menu-sep" />
        ) : (
          <div
            key={i}
            className={
              "menu-item" +
              (item.disabled ? " disabled" : "") +
              (item.submenu ? " has-sub" : "") +
              (item.checked ? " checked" : "") +
              (sub?.i === i ? " sub-open" : "")
            }
            onMouseEnter={(e) => {
              if (item.submenu && !item.disabled) {
                const r = e.currentTarget.getBoundingClientRect();
                setSub({ i, x: r.right - 4, y: r.top - 4 });
              } else {
                setSub(null);
              }
            }}
            onClick={() => {
              if (item.disabled || item.submenu) return;
              item.action?.();
              onClose();
            }}
          >
            {hasChecks && (
              <span className="mi-check">{item.checked ? <Check size={14} /> : null}</span>
            )}
            <span className="mi-label">{item.label}</span>
            {item.key && <span className="mi-key">{item.key}</span>}
            {item.submenu && <ChevronRight size={14} className="mi-sub" />}
          </div>
        )
      )}
      {sub != null && items[sub.i]?.submenu && (
        <MenuPopup items={items[sub.i].submenu!} x={sub.x} y={sub.y} onClose={onClose} />
      )}
    </div>
  );
}

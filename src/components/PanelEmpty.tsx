import type { ReactNode } from "react";

/** Shared empty-state for the dock panels (Compare, Timeline): a dashed card,
 *  pinned to the top of the panel (not vertically centered). Content varies per
 *  panel; the card frame / type scale stay consistent across them. */
export function PanelEmpty({ icon, title, children }: {
  icon?: ReactNode;
  title: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="panel-empty-wrap scroll">
      <div className="panel-empty">
        {icon && <div className="panel-empty-icon">{icon}</div>}
        <div className="panel-empty-title">{title}</div>
        {children}
      </div>
    </div>
  );
}

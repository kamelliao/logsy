import type { ReactNode } from "react";

interface Props {
  // The file currently being read from disk, or null.
  busy: { name: string } | null;
  // A filter/pack file being read from disk (store-driven), or null.
  loadingLabel: string | null;
  // True while React computes the view for a freshly selected large file.
  isSwitchingFile: boolean;
}

/**
 * Full-window status overlays: the disk-read spinner and the file-switch spinner.
 * (The drag-and-drop prompt is now a per-zone indicator over the log view — see
 * App's dropHint — so there's no full-window drop overlay to fight with it.)
 * Purely presentational — state lives in useLogFiles.
 */
export function Overlays({
  busy,
  loadingLabel,
  isSwitchingFile,
}: Props): ReactNode {
  return (
    <>
      {/* loading indicator — shown while a log file is read from disk. Passive
          (click-through) so the app stays usable: the user can keep working in,
          or switch to, another open file while a slow read is in flight. */}
      {busy && (
        <div className="busy-overlay passive">
          <div className="busy-card">
            <div className="busy-spinner" />
            <div className="busy-text">Opening {busy.name}…</div>
          </div>
        </div>
      )}

      {/* loading overlay — shown while a filter/pack file is read from disk */}
      {loadingLabel && !busy && (
        <div className="busy-overlay">
          <div className="busy-card">
            <div className="busy-spinner" />
            <div className="busy-text">Loading {loadingLabel}…</div>
          </div>
        </div>
      )}

      {/* file-switch overlay — shown while React computes the view for a large file */}
      {isSwitchingFile && !busy && !loadingLabel && (
        <div className="busy-overlay">
          <div className="busy-card">
            <div className="busy-spinner" />
            <div className="busy-text">Loading…</div>
          </div>
        </div>
      )}
    </>
  );
}

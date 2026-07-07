import { Upload } from "lucide-react";
import type { ReactNode } from "react";

interface Props {
  // The file currently being read from disk, or null.
  busy: { name: string } | null;
  // A filter/pack file being read from disk (store-driven), or null.
  loadingLabel: string | null;
  // True while React computes the view for a freshly selected large file.
  isSwitchingFile: boolean;
  // True while a file is dragged over the window.
  dragOver: boolean;
}

/**
 * Full-window status overlays: the disk-read spinner, the file-switch spinner,
 * and the drag-and-drop prompt. Purely presentational — state lives in
 * useLogFiles.
 */
export function Overlays({
  busy,
  loadingLabel,
  isSwitchingFile,
  dragOver,
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

      {/* drag-and-drop overlay */}
      {dragOver && (
        <div className="drop-overlay">
          <div className="drop-overlay-inner">
            <Upload size={34} />
            <div className="do-title">Drop log files to open</div>
          </div>
        </div>
      )}
    </>
  );
}

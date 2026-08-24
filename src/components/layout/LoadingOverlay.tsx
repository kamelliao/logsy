import type { ReactNode } from "react";
import type { BusyTask } from "@/store/slices/uiSlice";

interface Props {
  /** The task to show, or null when nothing is in flight. */
  busy: BusyTask | null;
}

/**
 * The one loading overlay in the app.
 *
 * There used to be three — a passive card for the log read, a full-window modal
 * scrim for the filter/pack read, and another for the file switch — which meant
 * three different answers to "can I keep working?". Now there is a single card,
 * scoped to the log panel it is rendered into (absolutely positioned, so the
 * sidebar, the tab strip and the filter panel stay live): loading a file never
 * stops the user from switching to another one, or changing filter set.
 *
 * Cancel appears whenever the task can be abandoned. Everything else about the
 * card — the scrim, the spinner, the wording — is the same whatever is loading.
 *
 * Purely presentational; the task stack lives in the store (`busyStack`).
 */
export function LoadingOverlay({ busy }: Props): ReactNode {
  if (!busy) return null;
  return (
    <div
      className="busy-overlay"
      // The empty-workspace slot this can also cover is one big "open a file"
      // click target; the scrim must not act as one.
      onClick={(e) => e.stopPropagation()}
    >
      <div className="busy-card">
        <div className="busy-spinner" />
        <div className="busy-text">{busy.label}…</div>
        {busy.cancel && (
          <button type="button" className="busy-cancel" onClick={busy.cancel}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

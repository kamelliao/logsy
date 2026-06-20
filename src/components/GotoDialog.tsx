import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

interface Props {
  onSubmit: (line: number) => void;
  onClose: () => void;
}

/**
 * The "Go to line" dialog. Rendered only while open, so it owns its input value
 * and autofocuses on mount. Submits a valid 1-based line number to `onSubmit`
 * (App turns it into a scroll signal for LogView) and always closes afterwards.
 */
export function GotoDialog({ onSubmit, onClose }: Props): ReactNode {
  const [val, setVal] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const submit = () => {
    const n = parseInt(val, 10);
    if (Number.isFinite(n) && n > 0) onSubmit(n);
    onClose();
  };

  return (
    <div className="goto-overlay" onMouseDown={onClose}>
      <div className="goto-box" onMouseDown={(e) => e.stopPropagation()}>
        <div className="goto-title">Go to line</div>
        <input
          ref={inputRef}
          className="goto-input"
          type="number"
          min={1}
          placeholder="Line number…"
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
            if (e.key === "Escape") onClose();
          }}
        />
        <div className="goto-actions">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit}>Go</Button>
        </div>
      </div>
    </div>
  );
}

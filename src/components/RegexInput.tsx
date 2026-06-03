import { forwardRef, useImperativeHandle, useRef, type ReactNode } from "react";
import { tokenizeRegex, type RegexToken } from "../lib/regexHighlight";

interface RegexInputProps {
  value: string;
  invalid?: boolean;
  placeholder?: string;
  onChange: (value: string) => void;
}

// Render flat tokens into nested spans so each parenthesised group can carry a
// background. Capture groups — numbered `(` and named `(?<name>` — get a tinted
// wrapper; non-capturing / lookaround groups get a transparent one (still nested
// to keep paren matching correct). Only `background` is applied to wrappers: any
// padding/margin would shift glyphs out of line with the input underneath.
function renderTokens(tokens: RegexToken[]): ReactNode[] {
  interface Frame { children: ReactNode[]; capturing: boolean }
  const root: ReactNode[] = [];
  const stack: Frame[] = [];
  let key = 0;
  const sink = () => (stack.length ? stack[stack.length - 1].children : root);
  const close = (frame: Frame) =>
    sink().push(
      <span key={key++} className={"rx-groupwrap" + (frame.capturing ? " cap" : "")}>
        {frame.children}
      </span>,
    );

  for (const tk of tokens) {
    const isOpen = tk.t === "group" && tk.s[0] === "(";
    const isClose = tk.t === "group" && tk.s === ")";
    if (isOpen) {
      const frame: Frame = { children: [], capturing: tk.s === "(" || tk.s === "(?<" };
      frame.children.push(<span key={key++} className="rx-group">{tk.s}</span>);
      stack.push(frame);
    } else if (isClose && stack.length) {
      const frame = stack.pop()!;
      frame.children.push(<span key={key++} className="rx-group">{tk.s}</span>);
      close(frame);
    } else {
      sink().push(<span key={key++} className={"rx-" + tk.t}>{tk.s}</span>);
    }
  }
  // Unwind groups left open while the user is mid-typing (innermost first).
  while (stack.length) close(stack.pop()!);
  return root;
}

/**
 * Single-line input that paints regex syntax highlighting *behind* a real
 * `<input>`. The input's own text is transparent (caret + selection stay
 * visible); a synced overlay renders the coloured tokens. Box metrics mirror
 * `.pattern-input` so the two layers line up to the pixel.
 */
export const RegexInput = forwardRef<HTMLInputElement, RegexInputProps>(
  function RegexInput({ value, invalid, placeholder, onChange }, ref) {
    const inputRef = useRef<HTMLInputElement>(null);
    const hlRef = useRef<HTMLDivElement>(null);
    useImperativeHandle(ref, () => inputRef.current!, []);

    // Keep the highlight layer scrolled in lock-step with the input.
    const syncScroll = () => {
      if (hlRef.current && inputRef.current) hlRef.current.scrollLeft = inputRef.current.scrollLeft;
    };

    return (
      <div className={"regex-input" + (invalid ? " invalid" : "")}>
        <div className="regex-hl" ref={hlRef} aria-hidden="true">
          {renderTokens(tokenizeRegex(value))}
        </div>
        <input
          ref={inputRef}
          className="regex-input-el"
          value={value}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(e) => onChange(e.target.value)}
          onScroll={syncScroll}
        />
      </div>
    );
  }
);

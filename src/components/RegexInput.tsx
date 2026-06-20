import {
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type ReactNode,
} from "react";
import { tokenizeRegex, type RegexToken } from "@/lib/regexHighlight";

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
  interface Frame {
    children: ReactNode[];
    capturing: boolean;
    gi?: number;
  }
  const root: ReactNode[] = [];
  const stack: Frame[] = [];
  let key = 0;
  // Named groups get the shared --rxg palette (same hues as the match preview
  // and parsed-fields dots) so pattern ↔ result correspondence is visible.
  let namedIdx = 0;
  const sink = () => (stack.length ? stack[stack.length - 1].children : root);
  const close = (frame: Frame) =>
    sink().push(
      <span
        key={key++}
        className={
          "rx-groupwrap" +
          (frame.capturing ? " cap" : "") +
          (frame.gi !== undefined ? ` g${frame.gi % 6}` : "")
        }
      >
        {frame.children}
      </span>,
    );

  for (const tk of tokens) {
    const isOpen = tk.t === "group" && tk.s[0] === "(";
    const isClose = tk.t === "group" && tk.s === ")";
    if (isOpen) {
      const named = tk.s === "(?<";
      const frame: Frame = {
        children: [],
        capturing: tk.s === "(" || named,
        gi: named ? namedIdx++ : undefined,
      };
      frame.children.push(
        <span key={key++} className="rx-group">
          {tk.s}
        </span>,
      );
      stack.push(frame);
    } else if (isClose && stack.length) {
      const frame = stack.pop()!;
      frame.children.push(
        <span key={key++} className="rx-group">
          {tk.s}
        </span>,
      );
      close(frame);
    } else {
      sink().push(
        <span key={key++} className={"rx-" + tk.t}>
          {tk.s}
        </span>,
      );
    }
  }
  // Unwind groups left open while the user is mid-typing (innermost first).
  while (stack.length) close(stack.pop()!);
  return root;
}

/**
 * Pattern editor that paints regex syntax highlighting *behind* a real
 * `<textarea>`. The textarea's own text is transparent (caret + selection stay
 * visible); a synced overlay renders the coloured tokens. The textarea soft-
 * wraps and auto-grows (capped in CSS, then scrolls) so long patterns are
 * fully visible instead of panning horizontally — but the pattern is still one
 * logical line: Enter is swallowed and pasted newlines are stripped. Both
 * layers share identical box metrics and wrapping rules (`pre-wrap` +
 * `break-all`) so the glyphs line up to the pixel.
 */
export const RegexInput = forwardRef<HTMLTextAreaElement, RegexInputProps>(
  function RegexInput({ value, invalid, placeholder, onChange }, ref) {
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const hlRef = useRef<HTMLDivElement>(null);
    useImperativeHandle(ref, () => inputRef.current!, []);

    // Auto-grow with content; CSS max-height caps it, after which it scrolls.
    useLayoutEffect(() => {
      const ta = inputRef.current;
      if (!ta) return;
      ta.style.height = "0";
      ta.style.height = ta.scrollHeight + "px";
    }, [value]);

    // Keep the highlight layer scrolled in lock-step with the textarea.
    const syncScroll = () => {
      const ta = inputRef.current,
        hl = hlRef.current;
      if (!ta || !hl) return;
      hl.scrollTop = ta.scrollTop;
      hl.scrollLeft = ta.scrollLeft;
    };

    return (
      <div className={"regex-input" + (invalid ? " invalid" : "")}>
        <div className="regex-hl" ref={hlRef} aria-hidden="true">
          {renderTokens(tokenizeRegex(value))}
        </div>
        <textarea
          ref={inputRef}
          className="regex-input-el"
          rows={1}
          value={value}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          // A pattern is one logical line: Enter must never insert a newline.
          // preventDefault doesn't stop propagation, so Ctrl+Enter still
          // reaches the modal's save handler.
          onKeyDown={(e) => {
            if (e.key === "Enter") e.preventDefault();
          }}
          onChange={(e) => onChange(e.target.value.replace(/[\r\n]+/g, ""))}
          onScroll={syncScroll}
        />
      </div>
    );
  },
);

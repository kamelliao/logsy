// A filter's pattern as the JS engine sees it. The one place that decides what a
// `Filter` compiles to, so the cache key (source + flags) means the same thing to
// everyone who computes it.
import type { Filter, CompiledFilter } from "@/types";

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function compile(f: Filter): CompiledFilter {
  if (!f.pattern || !f.pattern.length)
    return { f, re: null, ok: true, empty: true };
  try {
    const src = f.regex ? f.pattern : escapeRegex(f.pattern);
    const flags = f.caseSensitive ? "g" : "gi";
    return { f, re: new RegExp(src, flags), ok: true };
  } catch (e) {
    // Keep only the engine's reason — the pattern is already on screen. V8
    // says "Invalid regular expression: /…/gi: reason" (echoing the whole
    // source); JSC (bun tests) says "Invalid regular expression: reason".
    const msg = (e as Error).message;
    const m =
      /^Invalid regular expression: (?:\/[\s\S]*\/[a-z]*: )?([\s\S]+)$/.exec(
        msg,
      );
    return { f, re: null, ok: false, err: m ? m[1] : msg };
  }
}

export function compileAll(filters: Filter[]): CompiledFilter[] {
  return filters.map(compile);
}

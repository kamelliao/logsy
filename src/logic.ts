import type { Filter, CompiledFilter, ViewResult, Segment } from "./types";

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function compile(f: Filter): CompiledFilter {
  if (!f.pattern || !f.pattern.length) return { f, re: null, ok: true, empty: true };
  try {
    const src = f.regex ? f.pattern : escapeRegex(f.pattern);
    const flags = f.caseSensitive ? "g" : "gi";
    return { f, re: new RegExp(src, flags), ok: true };
  } catch (e) {
    return { f, re: null, ok: false, err: (e as Error).message };
  }
}

export function compileAll(filters: Filter[]): CompiledFilter[] {
  return filters.map(compile);
}

function testRe(re: RegExp, line: string): boolean {
  re.lastIndex = 0;
  return re.test(line);
}

export function countMatches(lines: string[], re: RegExp): number {
  let c = 0;
  for (let i = 0; i < lines.length; i++) {
    re.lastIndex = 0;
    if (re.test(lines[i])) c++;
  }
  return c;
}

export function segments(text: string, re: RegExp | null): Segment[] {
  if (!re) return [{ t: text, hit: false }];
  re.lastIndex = 0;
  const out: Segment[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let guard = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ t: text.slice(last, m.index), hit: false });
    if (m[0].length) out.push({ t: m[0], hit: true });
    last = m.index + (m[0].length || 0);
    if (m[0].length === 0) re.lastIndex++;
    if (++guard > 5000) break;
  }
  if (last < text.length) out.push({ t: text.slice(last), hit: false });
  if (!out.length) out.push({ t: text, hit: false });
  return out;
}

export function computeView(lines: string[], compiled: CompiledFilter[]): ViewResult {
  const active = compiled.filter((c) => c.f.enabled && !c.empty && c.ok && c.re);
  const excludes = active.filter((c) => c.f.exclude);
  const highlights = active.filter((c) => !c.f.exclude);

  const counts: Record<string, number> = {};
  for (const c of compiled) {
    counts[c.f.id] = c.re ? countMatches(lines, c.re) : 0;
  }

  const rows = lines.map((text, i) => {
    let excluded = false;
    for (const e of excludes) {
      if (testRe(e.re!, text)) { excluded = true; break; }
    }
    let winner: CompiledFilter | null = null;
    for (const h of highlights) {
      if (testRe(h.re!, text)) { winner = h; break; }
    }
    return { n: i + 1, text, winner, excluded };
  });

  return {
    rows,
    counts,
    hasHighlights: highlights.length > 0,
    hasExcludes: excludes.length > 0,
  };
}

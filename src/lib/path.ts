/** The final path segment (file name) of an OS path, handling both separators. */
export function baseName(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/**
 * VS Code–style filename disambiguation. Given the open files, returns a map of
 * file id → the shortest trailing run of parent-directory segments that tells it
 * apart from other files sharing its display name (e.g. `deviceA/0703`). Files
 * whose name is unique — and files with no path to derive from — map to
 * `undefined` (no suffix shown). Pure derived UI state: no undo/persist.
 *
 * Only files that collide get a suffix, so opening an unrelated file never
 * decorates the existing rows. The suffix can grow as more same-named files
 * appear (inherent to "shortest distinguishing"), matching VS Code's behavior.
 */
export function disambiguationSuffixes(
  files: readonly { id: string; name: string; path: string | null }[],
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  // Bucket by the label the sidebar actually shows (the file name).
  const byName = new Map<string, (typeof files)[number][]>();
  for (const f of files) {
    const arr = byName.get(f.name);
    if (arr) arr.push(f);
    else byName.set(f.name, [f]);
  }
  for (const group of byName.values()) {
    if (group.length < 2) continue; // unique name → no suffix needed
    // Parent-directory segments per file (basename dropped), nearest parent last.
    const segsById = new Map<string, string[]>();
    for (const f of group) {
      if (!f.path) continue;
      const parts = f.path.split(/[\\/]/).filter(Boolean);
      parts.pop(); // drop the basename itself
      if (parts.length) segsById.set(f.id, parts);
    }
    // For each file, grow the suffix (nearest parent first) until it is unique
    // among the other path-bearing files in this collision group.
    const suffixAt = (parts: string[], k: number) =>
      parts.slice(Math.max(0, parts.length - k)).join("/");
    for (const f of group) {
      const parts = segsById.get(f.id);
      if (!parts) continue;
      const maxK = Math.max(
        ...group.map((o) => segsById.get(o.id)?.length ?? 0),
      );
      for (let k = 1; k <= maxK; k++) {
        const s = suffixAt(parts, k);
        const clash = group.some(
          (o) =>
            o.id !== f.id &&
            segsById.has(o.id) &&
            suffixAt(segsById.get(o.id)!, k) === s,
        );
        if (!clash || k === maxK) {
          out[f.id] = s;
          break;
        }
      }
    }
  }
  return out;
}

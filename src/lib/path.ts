/** The final path segment (file name) of an OS path, handling both separators. */
export function baseName(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Human-readable byte size, e.g. 934 → "934 B", 4_400_000 → "4.2 MB". */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  // One decimal below 10 (4.2 MB), none above (128 MB) — keeps it compact.
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

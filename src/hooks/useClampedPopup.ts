import { useLayoutEffect, useRef, useState } from "react";

/**
 * Keep a fixed-position popup fully on screen. Given the raw anchor point (a
 * right-click's clientX/clientY, or a point under a kebab), it measures the
 * popup after it mounts and clamps left/top so the menu never spills past a
 * viewport edge — the sidebar's "Move to group" list used to run off the bottom
 * of the screen and get cut off once enough groups existed. Pair with a CSS
 * `max-height` so a menu that is *taller* than the viewport scrolls instead.
 *
 * useLayoutEffect runs before paint, so the clamped position is applied before
 * the user ever sees the menu at its raw anchor.
 */
export function useClampedPopup(anchor: { x: number; y: number } | null) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: anchor?.x ?? 0, top: anchor?.y ?? 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!anchor || !el) return;
    const M = 8; // keep at least this gap from every viewport edge
    const { width, height } = el.getBoundingClientRect();
    setPos({
      left: Math.max(M, Math.min(anchor.x, window.innerWidth - width - M)),
      top: Math.max(M, Math.min(anchor.y, window.innerHeight - height - M)),
    });
  }, [anchor]);
  return { ref, left: pos.left, top: pos.top };
}

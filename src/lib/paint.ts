// Yield a paint so a just-set loading overlay actually renders before a heavy
// synchronous step (splitting a large file, applying an imported filter set)
// blocks the main thread. Two rAFs: the first schedules after the current frame,
// the second resolves after the browser has had a chance to paint.
export function nextPaint(): Promise<void> {
  return new Promise((r) =>
    requestAnimationFrame(() => requestAnimationFrame(() => r())),
  );
}

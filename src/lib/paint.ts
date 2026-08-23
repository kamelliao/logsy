// Yield a paint so a just-set loading overlay actually renders before a heavy
// synchronous step (splitting a large file, applying an imported filter set)
// blocks the main thread. Two rAFs: the first schedules after the current frame,
// the second resolves after the browser has had a chance to paint.
export function nextPaint(): Promise<void> {
  // A macrotask outside a browser (unit tests, any non-DOM caller). Callers use this
  // to stay interruptible, so it has to resolve everywhere rather than throw where
  // there is no rAF.
  if (typeof requestAnimationFrame !== "function")
    return new Promise((r) => setTimeout(r, 0));
  return new Promise((r) =>
    requestAnimationFrame(() => requestAnimationFrame(() => r())),
  );
}

/**
 * Yield to the event loop so pending input is delivered, WITHOUT waiting for a frame.
 *
 * `nextPaint` is the wrong tool inside a work loop: two rAFs cost ~33 ms, so slicing
 * 12 ms of work behind it runs at a 27% duty cycle and turns a 1.7 s scan into a 6 s
 * one. This resolves on the next macrotask instead — long enough for a click to be
 * dispatched, short enough that the slicing is nearly free.
 *
 * `scheduler.yield()` is exactly this primitive where it exists (Chromium, so the
 * app's WebView); `MessageChannel` is the portable equivalent, and `setTimeout` the
 * last resort (its 4 ms clamp is why it is last).
 */
export function yieldToEventLoop(): Promise<void> {
  const scheduler = (
    globalThis as { scheduler?: { yield?: () => Promise<void> } }
  ).scheduler;
  if (typeof scheduler?.yield === "function") return scheduler.yield();
  // Node/bun (scripts, tests): `setImmediate` is the cheapest macrotask there, and
  // unlike a MessagePort it does not hold the event loop open — a long-lived channel
  // keeps a process that has finished its work from ever exiting.
  const setImmediate = (
    globalThis as { setImmediate?: (cb: () => void) => void }
  ).setImmediate;
  if (typeof setImmediate === "function")
    return new Promise((r) => setImmediate(() => r()));
  if (typeof MessageChannel === "function") return messageYield();
  return new Promise((r) => setTimeout(r, 0));
}

// ONE channel for the lifetime of the page, not one per yield. A fresh MessageChannel
// per call leaks two ports each time — enough to keep an event loop alive forever
// (which is exactly how this was first written, and it hung a scan that had already
// finished its work).
let channel: MessageChannel | undefined;
const waiters: (() => void)[] = [];

function messageYield(): Promise<void> {
  if (!channel) {
    channel = new MessageChannel();
    // One post, one message, one waiter released — so the queue can't drift.
    channel.port1.onmessage = () => waiters.shift()?.();
  }
  return new Promise((resolve) => {
    waiters.push(resolve);
    channel!.port2.postMessage(null);
  });
}

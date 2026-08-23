// Open-performance telemetry: one log line per file open, accounting for every
// stage of the pipeline.
//
// It exists for the report we can't otherwise get. "Opening this log was slow" can
// mean a stalled network read, a filter set whose patterns all fell back to the JS
// scanner, or something else entirely — and a release build has no devtools console
// to check. With the whole pipeline in one line, the log a user sends back says
// which stage it was.
//
// The stages are measured in two different places: the IO ones by `useLogFiles` when
// the file lands, and `view` by App on the render that follows. So a record is opened
// here when the file is ready and completed once its first `computeView` has run.
//
// Deliberately records the bare file name and pattern counts only — never a path or a
// filter pattern. The log is meant to be shareable, and both can carry internal terms.
import { info } from "@tauri-apps/plugin-log";

export interface OpenStages {
  /** File name only — never the path. */
  name: string;
  bytes: number;
  lines: number;
  encoding: string;
  patterns: number;
  primed: number;
  /** Of `primed`, how many were assembled from branch bit sets rather than scanned. */
  composed: number;
  fallback: number;
  rejected: number;
  /** Patterns Rust couldn't take, scanned in JS — sliced, off the render path. */
  jsScanned: number;
  /** Rust-side stages, reported back in the scan blob's header. */
  readMs: number;
  splitMs: number;
  scanMs: number;
  /** `read_text_file` round trip: the disk read plus shipping the text over IPC. */
  ipcMs: number;
  jsSplitMs: number;
  /** The `scan_lines` round trip, verification and cache priming. */
  primeMs: number;
  /** The sliced JS scan of whatever Rust couldn't take. Time the user waits in the
   *  loading overlay — but interruptible, unlike the `view` it used to land in. */
  jsScanMs: number;
  /** When the open began, for the total. */
  startedAt: number;
}

// Keyed by file id. A pending record is normal for one render; it is dropped if the
// view never arrives (file closed mid-open), so this can't grow.
const pending = new Map<string, OpenStages>();

/** Record the IO stages for a file that just landed; completed by `finishOpenTiming`. */
export function beginOpenTiming(fileId: string, stages: OpenStages): void {
  pending.set(fileId, stages);
}

/**
 * Render one `key=value` pair in logfmt: values are quoted only when they contain
 * whitespace, a quote or an `=`, which is what keeps a file name with a space in it
 * from splitting the record into two fields.
 */
function pair(key: string, value: string | number): string {
  const v = String(value);
  return /[\s"=]/.test(v)
    ? `${key}="${v.replace(/["\\]/g, "\\$&")}"`
    : `${key}=${v}`;
}

/**
 * Complete and emit the record for `fileId`, if one is pending. Called after every
 * view computation; a file with no pending record (a filter toggle, a tab switch)
 * is a no-op, so callers don't need to know which render is the interesting one.
 *
 * Emitted as a single logfmt line. One line because the log file prefixes each
 * *record*, not each line — a multi-line record leaves its continuation without a
 * timestamp, and grep returns half of it. logfmt because these records are read
 * two ways: by eye when a user sends the file back, and by `grep event=open_file`
 * (or a two-line script) when comparing many opens.
 */
export function finishOpenTiming(fileId: string, viewMs: number): void {
  const s = pending.get(fileId);
  if (!s) return;
  pending.delete(fileId);
  const ms = (v: number) => Math.round(v);
  info(
    [
      pair("event", "open_file"),
      pair("file", s.name),
      pair("bytes", s.bytes),
      pair("lines", s.lines),
      pair("encoding", s.encoding),
      // The scan outcome is bracketed onto the filter count it breaks down, so the
      // three numbers read as one fact rather than three loose fields.
      `${pair("filters", s.patterns)} (${pair("primed", s.primed)} ` +
        `${pair("composed", s.composed)} ` +
        `${pair("fallback", s.fallback)} ${pair("rejected", s.rejected)} ` +
        `${pair("js", s.jsScanned)})`,
      pair("read_ms", ms(s.readMs)),
      pair("ipc_ms", ms(s.ipcMs)),
      pair("js_split_ms", ms(s.jsSplitMs)),
      pair("rust_split_ms", ms(s.splitMs)),
      pair("scan_ms", ms(s.scanMs)),
      pair("prime_ms", ms(s.primeMs)),
      pair("js_scan_ms", ms(s.jsScanMs)),
      pair("view_ms", ms(viewMs)),
      pair("total_ms", ms(performance.now() - s.startedAt)),
    ].join(" "),
    // Telemetry must never break an open: no shell (browser dev, e2e), no logging.
  ).catch(() => {});
}

/** Drop a pending record without emitting it (the open was abandoned). */
export function cancelOpenTiming(fileId: string): void {
  pending.delete(fileId);
}

/**
 * Split a log file's text into lines.
 *
 * Every line index in the app is an index into this result — the match bit sets, the
 * bookmarks, the compare rows, the timeline marks. So this split has to be one
 * function with one definition: a second copy that disagrees about a trailing newline
 * or a lone CR shifts every one of those by one, silently.
 *
 * It lives here, on its own, because three places need it and only one of them can
 * import a React hook: `useLogFiles` on the read path, `scripts/profile.ts`, and
 * `scripts/crosscheck.ts` — which used to keep a hand-copy annotated "must stay
 * identical to". `split_lines` in `src-tauri/src/scan.rs` is a fourth implementation
 * that cannot share this one (different language, and it runs before the text ever
 * reaches JS); `test:crosscheck` exists to prove the two agree.
 *
 * A single trailing empty element is dropped, so "a\nb\n" is two lines rather than
 * three — a file ending in a newline does not gain a phantom last line.
 */
export function splitLines(text: string): string[] {
  const arr = text.split(/\r\n|\n|\r/);
  if (arr.length > 0 && arr[arr.length - 1] === "") arr.pop();
  return arr;
}

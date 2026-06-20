import { test, expect } from "bun:test";
import {
  compileAll,
  computeView,
  coerceValue,
  coerceTime,
  guessUnit,
  buildTimeline,
  trackFieldsOf,
} from "@/lib/engine";
import { normalizeState } from "@/lib/defaults";
import type { Filter, FieldDef, TimelineSource, AppState } from "@/types";

function filter(
  id: string,
  pattern: string,
  fields: FieldDef[],
  over: Partial<Filter> = {},
): Filter {
  return {
    id,
    pattern,
    description: "",
    enabled: true,
    caseSensitive: false,
    regex: true,
    exclude: false,
    textColor: "#000",
    bgColor: "#fff",
    groupId: null,
    fields,
    ...over,
  };
}
const viewOf = (lines: string[], filters: Filter[]) =>
  computeView(lines, compileAll(filters));
const track = (
  filterId: string,
  timeField: string,
  over: Partial<TimelineSource> = {},
): TimelineSource => ({
  id: "t_" + filterId + "_" + timeField,
  filterId,
  timeField,
  lane: timeField,
  kind: "point",
  unit: "hms",
  ...over,
});

// --- unit-aware time coercion → nanoseconds ---------------------------------

test("coerceTime with a unit normalizes to nanoseconds", () => {
  expect(coerceTime("00:00:01.500", "hms")).toBe(1_500_000_000);
  expect(coerceTime("5", "s")).toBe(5_000_000_000);
  expect(coerceTime("12345", "ms")).toBe(12_345_000_000);
  expect(coerceTime("250", "us")).toBe(250_000);
  expect(coerceTime("999", "ns")).toBe(999);
});

test("coerceTime falls back to the raw string when not a number", () => {
  expect(coerceTime("nope", "ms")).toBe("nope");
});

test("coerceValue stays legacy (no scaling) when no unit is given", () => {
  expect(coerceValue("00:00:01.500", "time")).toBe(1500);
  expect(coerceValue("12.5", "time", "ms")).toBe(12_500_000);
});

test("guessUnit reads a unit suffix, else assumes a clock", () => {
  expect(guessUnit("ts")).toBe("hms");
  expect(guessUnit("t_ms")).toBe("ms");
  expect(guessUnit("uptime_us")).toBe("us");
  expect(guessUnit("delta_ns")).toBe("ns");
  expect(guessUnit("uptime_s")).toBe("s");
});

test("guessUnit infers from a sample value when the name has no suffix", () => {
  // a plain (fractional) number ⇒ seconds, not a clock
  expect(guessUnit("ts", "5.143152")).toBe("s");
  expect(guessUnit("ts", "42")).toBe("s");
  // a clock string ⇒ hms
  expect(guessUnit("ts", "12:34:56.789")).toBe("hms");
  // non-numeric / empty ⇒ fall back to hms
  expect(guessUnit("ts", "n/a")).toBe("hms");
  // a name suffix still wins over the sample
  expect(guessUnit("t_ms", "5.14")).toBe("ms");
});

// --- trackFieldsOf (the field pickers' source) ------------------------------

test("trackFieldsOf returns every field — any field can back a track, not just numeric", () => {
  const f = filter("a", "(?<ts>x)(?<lvl>y)(?<n>z)(?<h>w)", [
    { name: "ts", type: "time" },
    { name: "lvl", type: "string" },
    { name: "n", type: "int" },
    { name: "h", type: "hex" },
  ]);
  expect(trackFieldsOf(f).map((d) => d.name)).toEqual(["ts", "lvl", "n", "h"]);
});

// --- buildTimeline: added lines drive events, matched by filterId -----------

test("only added lines produce events", () => {
  const lines = ["00:00:01.000 a", "00:00:02.000 b"];
  const v = viewOf(lines, [
    filter("f", "(?<ts>\\d+:\\d+:\\d+\\.\\d+)\\s+(?<msg>.*)", [
      { name: "ts", type: "time" },
      { name: "msg", type: "string" },
    ]),
  ]);
  const marks = buildTimeline(v, [1], [track("f", "ts")]);
  expect(marks.map((m) => [m.lineN, m.t])).toEqual([[1, 1_000_000_000]]);
});

test("a track only fires for lines whose first-match filter is its filterId", () => {
  const lines = ["00:00:01.000 a"];
  const v = viewOf(lines, [
    filter("f", "(?<ts>\\d+:\\d+:\\d+\\.\\d+)", [{ name: "ts", type: "time" }]),
  ]);
  // track bound to a different filter id → no event, even though the field exists
  expect(buildTimeline(v, [1], [track("other", "ts")])).toEqual([]);
  expect(buildTimeline(v, [1], [track("f", "ts")]).length).toBe(1);
});

test("first-match precedence: the field provider is the first matching filter", () => {
  const lines = ["00:00:01.000 a"];
  // both match; "hi" is earlier in the list → it wins the field provider role
  const v = viewOf(lines, [
    filter("hi", "(?<ts>\\d+:\\d+:\\d+\\.\\d+)", [
      { name: "ts", type: "time" },
    ]),
    filter("lo", "(?<ts>\\d+:\\d+:\\d+\\.\\d+)", [
      { name: "ts", type: "time" },
    ]),
  ]);
  expect(buildTimeline(v, [1], [track("lo", "ts")])).toEqual([]); // not the provider
  expect(buildTimeline(v, [1], [track("hi", "ts")]).length).toBe(1);
});

test("one filter with several time fields yields one event per track", () => {
  const lines = ["send=100 recv=180 done"];
  const v = viewOf(lines, [
    filter("f", "send=(?<s>\\d+)\\s+recv=(?<r>\\d+)", [
      { name: "s", type: "time" },
      { name: "r", type: "time" },
    ]),
  ]);
  const marks = buildTimeline(
    v,
    [1],
    [track("f", "s", { unit: "ms" }), track("f", "r", { unit: "ms" })],
  );
  expect(marks.map((m) => [m.lane, m.t])).toEqual([
    ["s", 100_000_000],
    ["r", 180_000_000],
  ]);
});

test("a non-time numeric field can be a timestamp with a declared unit", () => {
  const lines = ["seq=4200"];
  const v = viewOf(lines, [
    filter("f", "seq=(?<seq>\\d+)", [{ name: "seq", type: "int" }]),
  ]);
  const marks = buildTimeline(v, [1], [track("f", "seq", { unit: "us" })]);
  expect(marks[0].t).toBe(4_200_000);
});

test("a span track pairs start/end fields from the same line", () => {
  const lines = ["start=10 end=42"];
  const v = viewOf(lines, [
    filter("f", "start=(?<a>\\d+)\\s+end=(?<b>\\d+)", [
      { name: "a", type: "time" },
      { name: "b", type: "time" },
    ]),
  ]);
  const marks = buildTimeline(
    v,
    [1],
    [track("f", "a", { kind: "span", endField: "b", unit: "ms" })],
  );
  expect(marks[0].t).toBe(10_000_000);
  expect(marks[0].end).toBe(42_000_000);
});

test("a span whose end is before its start drops the end and reports the track", () => {
  const lines = ["start=42 end=10"];
  const v = viewOf(lines, [
    filter("f", "start=(?<a>\\d+)\\s+end=(?<b>\\d+)", [
      { name: "a", type: "time" },
      { name: "b", type: "time" },
    ]),
  ]);
  const bad = new Set<string>();
  const tr = track("f", "a", { kind: "span", endField: "b", unit: "ms" });
  const marks = buildTimeline(v, [1], [tr], bad);
  // backwards span: rendered as a point (no end), and flagged for a warning.
  expect(marks[0].t).toBe(42_000_000);
  expect(marks[0].end).toBeUndefined();
  expect(bad.has(tr.id)).toBe(true);
});

test("hidden tracks emit nothing; the mark carries the line's parsed fields", () => {
  const lines = ["00:00:01.000 W42"];
  const v = viewOf(lines, [
    filter("f", "(?<ts>\\d+:\\d+:\\d+\\.\\d+)\\s+(?<tag>\\w+)", [
      { name: "ts", type: "time" },
      { name: "tag", type: "string" },
    ]),
  ]);
  expect(buildTimeline(v, [1], [track("f", "ts", { hidden: true })])).toEqual(
    [],
  );
  const marks = buildTimeline(v, [1], [track("f", "ts")]);
  expect(marks[0].fields?.tag.value).toBe("W42");
  expect(marks[0].label).toBe(lines[0]);
});

test("a line whose fields lack the track field is skipped", () => {
  const lines = ["00:00:01.000 a"];
  const v = viewOf(lines, [
    filter("f", "(?<ts>\\d+:\\d+:\\d+\\.\\d+)", [{ name: "ts", type: "time" }]),
  ]);
  expect(buildTimeline(v, [1], [track("f", "ghost")])).toEqual([]);
});

// --- persistence: normalizeState keeps every (filter, field) track -----------

test("normalizeState de-dupes tracks by (filterId, timeField), not field name alone", () => {
  // Two tracks share the field name "ts" but bind different filters — both must
  // survive a reload. The old code de-duped by timeField only, collapsing them.
  const sources: TimelineSource[] = [track("f1", "ts"), track("f2", "ts")];
  const state = {
    files: [
      {
        id: "file1",
        name: "log",
        sets: [
          {
            id: "g1",
            name: "set",
            filters: [],
            groups: [],
            order: [],
            sources,
          },
        ],
        activeSetId: "g1",
        markers: [],
      },
    ],
    activeFileId: "file1",
  } as unknown as AppState;
  const out = normalizeState(state);
  const kept = out.files[0].sets[0].sources;
  expect(kept?.length).toBe(2);
  expect(kept?.map((s) => s.filterId)).toEqual(["f1", "f2"]);
});

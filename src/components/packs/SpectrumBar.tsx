import type { Filter } from "@/types";

/** Cap segments so a huge pack doesn't render hair-thin slivers; the exact
 *  count lives in the card meta, the bar is a glanceable fingerprint. */
const MAX_SEGMENTS = 22;

/**
 * The signature element of a filter pack: a compact horizontal band built from
 * each filter's highlight colour, in pack order. Reads like a barcode unique to
 * that pack. Exclude filters get a diagonal hatch (they hide rather than paint);
 * disabled filters are dimmed. Purely decorative — labelled by the card around it.
 */
export function SpectrumBar({
  filters,
  className,
}: {
  filters: Filter[];
  className?: string;
}) {
  const shown = filters.slice(0, MAX_SEGMENTS);
  return (
    <div
      className={"spectrum" + (className ? " " + className : "")}
      aria-hidden
    >
      {shown.length === 0 ? (
        <span className="spectrum-seg empty" />
      ) : (
        shown.map((f, i) => (
          <span
            key={f.id || i}
            className={
              "spectrum-seg" +
              (f.exclude ? " exclude" : "") +
              (f.enabled === false ? " off" : "")
            }
            style={{ background: f.bgColor }}
            title={f.description || f.pattern}
          />
        ))
      )}
    </div>
  );
}

/**
 * Labelled numbers — "Bid 4 · Won 2", "Score 120" — in the one style every
 * readout uses: a quiet label, a number that is not.
 *
 * Seat pods, the viewer's own chip in the band and the round card each
 * used to print numbers their own way, most of them bare: "7 cards · 45",
 * "You: 0 · +0 / −45". A number with no label means nothing to anybody who
 * did not write it. A game now states its vocabulary once, as `StatLines`,
 * and every readout draws it with this.
 */

import { Fragment } from "react";
import { cn } from "@/lib/utils";

/** One labelled number. */
export interface Stat {
  label: string;
  value: string | number;
}

/** Lines of stats; the stats on one line are joined with a dot. */
export type StatLines = readonly (readonly Stat[])[];

export function Stats({
  lines,
  max = 2,
  className,
}: {
  lines: StatLines;
  /** Lines shown at most. The last one shown truncates if it must. */
  max?: number;
  className?: string;
}) {
  return lines.slice(0, Math.max(0, max)).map((line, i) => (
    // `leading-none` after the caller's classes: a Tailwind v4 font size
    // sets a line height too, so `cn` drops a `leading-*` that comes first
    // and a 9px line becomes 14px tall.
    <div key={i} className={cn("max-w-full truncate", className, "leading-none")}>
      {line.map((stat, j) => (
        <Fragment key={stat.label}>
          {j > 0 ? <span className="text-bone-500"> · </span> : null}
          <span className="text-bone-400">{stat.label} </span>
          <span className="tnum font-semibold text-bone-50">{stat.value}</span>
        </Fragment>
      ))}
    </div>
  ));
}

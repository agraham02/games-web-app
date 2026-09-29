"use client";

/**
 * The band directly above the viewer's hand, and everything in it: the
 * turn line, the viewer's own readouts, and whatever they are being asked
 * to decide right now.
 *
 * This exists because the alternative does not work. The obvious way to
 * put a score badge, a turn cue and a sort menu above the hand is three
 * independently `position: absolute` elements, each computing its own
 * `calc()` against `--hand-zone` and each carrying its own z-index. That
 * shape produced, in order: a badge that read as being INSIDE the sheet
 * below it, a popover overlapping the hand cards, a menu clipped past
 * the screen edge, and a running series of z-index bumps as more things
 * needed to coexist in the same visual band.
 *
 * Z-index bumping is a symptom, not a fix — it means two things occupy
 * the same space and are being told who wins, rather than being laid out
 * so they never occupy it at all. One positioned container with real
 * layout flow inside it is the fix.
 *
 * Three modes, one owner:
 *
 *  - **row** — `left` / `center` / `right`: ambient readouts, when there
 *    is nothing to decide.
 *  - **bar** — one row of actions for what you are doing right now; it
 *    takes the row's place.
 *  - **panel** — a decision that needs more than a row (Spades' bid,
 *    Poker's betting), stacked above the row or bar.
 *
 * The table reserves the band's ONE ROW (`ResolveOptions.bandZone`), so
 * nothing on the table is laid out under the turn line and the readouts. A
 * `panel` is not reserved: it is a temporary decision, and reserving it
 * re-laid the table out every time one opened — side seats jumping up for a
 * bid panel that never went near them. It is drawn over the felt while it is
 * open instead (the user's call, 2026-09-28).
 *
 * THREE EQUAL COLUMNS, and the "equal" is load-bearing. A `flex-1`
 * centre item centres itself within the space LEFT OVER after its
 * siblings, which is not the row's centre unless the siblings happen to
 * be the same width — that is exactly why a "centred" turn label sat
 * visibly off-centre whenever the left badge was wider than the right
 * one. Equal `1fr` columns make the centre column's own centre the row's
 * true centre no matter what flanks it. And `minmax(0, 1fr)` rather than
 * bare `1fr`, so a wide item shrinks inside its third instead of
 * blowing the track out and pushing the centre off again.
 *
 * The band hugs the hand rather than the screen: 48rem at most, centred.
 * Spread across a wide window, "You", the turn line and the menu sat at
 * three far edges of the screen — and in landscape the edges are where
 * the lowest seat pods are.
 *
 * The one positioned container is legitimate: it tracks the hand zone's
 * real runtime geometry, which moves per viewport and density.
 */

import { handHeaderHeight } from "./geometry";
import { useGeometry } from "./store";

// Re-exported: callers reserved the band by hand before the surface did.
export { HAND_HEADER_H, HAND_HEADER_H_SHORT, handHeaderHeight } from "./geometry";

export interface HandZoneProps {
  left?: React.ReactNode;
  center?: React.ReactNode;
  right?: React.ReactNode;
  /**
   * Takes over the WHOLE row when present, replacing the three columns.
   *
   * This is how a game puts a contextual action bar above the hand
   * without introducing a second floating band that has to be kept from
   * colliding with this one. Two things can never overlap here because
   * there is only ever one thing.
   */
  bar?: React.ReactNode;
  /**
   * A decision bigger than a row, above the row or bar — drawn over the
   * felt while it is open, never reserved (see the file's doc).
   */
  panel?: React.ReactNode;
  /**
   * The viewer holds no cards yet (a deal-size choice before the deal), so
   * the band may use the empty hand strip too: its content is centred in
   * the viewer's whole section — band and hand — rather than sitting on top
   * of a strip with nothing in it.
   */
  overHand?: boolean;
}

/**
 * The words beside a bar's buttons — "Nothing to play", "Choose 2 cards".
 * One style, so every game's bar reads as the same band.
 */
export function BandNote({ children }: { children: React.ReactNode }) {
  return (
    <span className="min-w-0 shrink truncate text-[10px] font-bold tracking-wide text-brass-300 uppercase">
      {children}
    </span>
  );
}

export function HandZone({ left, center, right, bar, panel, overHand = false }: HandZoneProps) {
  const geometry = useGeometry();
  if (!geometry) return null;

  const hand = geometry.zones.hand;
  const rowH = handHeaderHeight(geometry.box.h);

  return (
    <div
      // `pointer-events-none` on the shell so the felt and the cards
      // underneath stay reachable through the band's empty parts; each
      // cell turns them back on for its own content. Whole class strings
      // for the two modes — Tailwind reads source statically.
      className={
        overHand
          ? "pointer-events-none absolute z-1700 flex flex-col items-center justify-center"
          : "pointer-events-none absolute z-1700 flex flex-col items-center justify-end"
      }
      style={{
        left: hand.x,
        width: hand.w,
        bottom: geometry.box.h - (overHand ? hand.y + hand.h : hand.y),
        minHeight: overHand ? rowH + hand.h : rowH,
      }}
    >
      {/* The panel takes the hand's whole width, not the row's cap: a
          decision laid out as one row on a laptop (Poker's) needs more. */}
      {panel ? <div className="pointer-events-auto flex w-full justify-center px-3 pt-2">{panel}</div> : null}
      <div className="flex w-full max-w-3xl flex-col px-3">
        {bar ? (
          <div
            className="pointer-events-auto flex w-full min-w-0 items-center justify-center gap-2"
            style={{ minHeight: rowH }}
          >
            {bar}
          </div>
        ) : (
          <div
            className="grid items-center gap-2"
            style={{ minHeight: rowH, gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr)" }}
          >
            <div className="pointer-events-auto flex min-w-0 justify-start">{left}</div>
            <div className="pointer-events-auto flex min-w-0 justify-center">{center}</div>
            <div className="pointer-events-auto flex min-w-0 justify-end">{right}</div>
          </div>
        )}
      </div>
    </div>
  );
}

"use client";

/**
 * The one row that owns the band directly above the hero's hand.
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
 * The one positioned container is legitimate: it tracks the hand zone's
 * real runtime geometry, which moves per viewport and density.
 */

import { SHORT_VIEWPORT_H } from "./geometry";
import { useGeometry } from "./store";

/**
 * Height reserved for this row, in px.
 *
 * Deliberately not per-DENSITY: callers need it BEFORE `resolveTable`
 * has run (it feeds `ResolveOptions.bottomZone`, which is an input to
 * the very geometry that would tell you the density), so a
 * density-aware value would be circular.
 *
 * It does vary by viewport HEIGHT, which is not circular — the caller
 * already knows that before asking for any geometry. On a short screen
 * every vertical pixel is contested and 64px for one row of chips is
 * more than the row needs; 44 still clears the tallest thing that goes
 * in it (a pill button). See `SHORT_VIEWPORT_H`.
 */
export const HAND_HEADER_H = 64;
export const HAND_HEADER_H_SHORT = 44;

export function handHeaderHeight(viewportH: number): number {
  return viewportH < SHORT_VIEWPORT_H ? HAND_HEADER_H_SHORT : HAND_HEADER_H;
}

export interface HandZoneProps {
  left?: React.ReactNode;
  center?: React.ReactNode;
  right?: React.ReactNode;
  /**
   * Takes over the WHOLE row when present, replacing the three columns.
   *
   * This is how a game puts a contextual action bar above the hand
   * without introducing a second floating band that has to be kept from
   * colliding with this one. The band has one owner and two modes:
   * ambient readouts when there is nothing to decide, and the actions
   * for your current selection when there is. Two things can never
   * overlap here because there is only ever one thing.
   */
  bar?: React.ReactNode;
}

export function HandZone({ left, center, right, bar }: HandZoneProps) {
  const geometry = useGeometry();
  if (!geometry) return null;

  const hand = geometry.zones.hand;
  const headerH = handHeaderHeight(geometry.box.h);
  const shell = {
    left: hand.x,
    width: hand.w,
    top: hand.y - headerH,
    height: headerH,
  };

  if (bar) {
    return (
      <div
        className="pointer-events-none absolute z-1700 flex items-center justify-center px-3"
        style={shell}
      >
        <div className="pointer-events-auto flex w-full min-w-0 items-center justify-center gap-2">
          {bar}
        </div>
      </div>
    );
  }

  return (
    <div
      // `pointer-events-none` on the shell so the felt and the cards
      // underneath stay reachable through the row's empty thirds; each
      // cell turns them back on for its own content.
      className="pointer-events-none absolute z-1700 grid items-center gap-2 px-3"
      style={{
        ...shell,
        gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr)",
      }}
    >
      <div className="pointer-events-auto flex min-w-0 justify-start">{left}</div>
      <div className="pointer-events-auto flex min-w-0 justify-center">{center}</div>
      <div className="pointer-events-auto flex min-w-0 justify-end">{right}</div>
    </div>
  );
}

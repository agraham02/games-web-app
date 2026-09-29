"use client";

/**
 * Compress-then-pan for the viewer's own hand, for a game whose hand can
 * grow past the width of the screen.
 *
 * Mounting it is the opt-in: it publishes a `handScroll` value, which is
 * what makes layout's hand fan stop compressing at `MIN_HAND_GAP_FRACTION`
 * and overflow instead, and it draws the gesture surface and edge hint over
 * the hand strip (`PanSurface`). Unmounting hands the next game its plain,
 * unfloored fan back.
 *
 * Spades mounts it for its thirteen cards, which at half a card each pan on
 * every phone. BS needs it most — a player who calls wrong takes the whole
 * pile, and a hand of twenty-odd cards compressed to fit a phone is a row
 * of slivers. Rummy does the same through its own wiring, together with its
 * discard.
 */

import { useEffect, useRef } from "react";
import { handFanMaxScroll } from "./geometry";
import { PanSurface } from "./PanSurface";
import { useGeometry, useSetHandScroll, useTableStore } from "./store";

export function HandPan({ count }: { count: number }) {
  const geometry = useGeometry();
  const handScroll = useTableStore((s) => s.handScroll);
  const setHandScroll = useSetHandScroll();
  const range = geometry ? handFanMaxScroll(geometry, count) : 0;

  useEffect(() => {
    setHandScroll(0);
    return () => setHandScroll(null);
  }, [setHandScroll]);
  useHandPanStart(range);

  if (!geometry || handScroll === null) return null;
  return (
    <PanSurface
      within={geometry.zones.hand}
      axis="x"
      range={range}
      value={handScroll}
      onChange={setHandScroll}
    />
  );
}

/**
 * Starts an overflowing hand flush against its near edge, and keeps it
 * there while the hand grows, until the player drags it somewhere else.
 *
 * A pan of 0 CENTRES the fan (see `fanPanRange`), which hides cards off
 * both ends before the player has touched anything — with thirteen cards on
 * a 390px phone, the first and last card of the hand faded right out.
 * `+range/2` is the near edge: the hand begins where a hand begins, and
 * everything hidden is at the far end, behind the edge hint.
 *
 * "Starts" is every time the hand goes from fitting to overflowing, so each
 * new deal begins at the near edge again. And while the pan sits exactly
 * where this put it, it follows the edge as the deal adds cards; a pan the
 * player has moved is theirs, and only `PanSurface`'s clamp touches it.
 */
export function useHandPanStart(range: number): void {
  const handScroll = useTableStore((s) => s.handScroll);
  const setHandScroll = useSetHandScroll();
  const lastHalf = useRef(0);
  const half = range / 2;

  useEffect(() => {
    if (handScroll === null) return;
    const was = lastHalf.current;
    lastHalf.current = half;
    if (half <= 0.5) return;
    const starting = was <= 0.5;
    const stillOurs = Math.abs(handScroll - was) < 0.5;
    if ((starting || stillOurs) && handScroll !== half) setHandScroll(half);
  }, [half, handScroll, setHandScroll]);
}

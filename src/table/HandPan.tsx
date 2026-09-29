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
 * BS needs it most — a player who calls wrong takes the whole pile, and a
 * hand of twenty-odd cards compressed to fit a phone is a row of slivers.
 * Rummy does the same through its own wiring, together with its discard.
 */

import { useEffect } from "react";
import { handFanMaxScroll } from "./geometry";
import { PanSurface } from "./PanSurface";
import { useGeometry, useSetHandScroll, useTableStore } from "./store";

export function HandPan({ count }: { count: number }) {
  const geometry = useGeometry();
  const handScroll = useTableStore((s) => s.handScroll);
  const setHandScroll = useSetHandScroll();

  useEffect(() => {
    setHandScroll(0);
    return () => setHandScroll(null);
  }, [setHandScroll]);

  if (!geometry || handScroll === null) return null;
  return (
    <PanSurface
      within={geometry.zones.hand}
      axis="x"
      range={handFanMaxScroll(geometry, count)}
      value={handScroll}
      onChange={setHandScroll}
    />
  );
}

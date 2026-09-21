"use client";

/**
 * The felt surface, and the thing that measures it.
 *
 * Geometry is derived from the measured element rather than from the
 * window, so the same table works full-screen, inside a lab preview
 * frame, or in a phone mock — anything that can be sized can host a
 * table.
 *
 * Sizing uses `svh`, not `vh` or `dvh`: `vh` ignores mobile browser
 * chrome and overflows, `dvh` reflows every time the address bar slides
 * and would re-run layout mid-animation. `svh` is the stable one.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PieceId, SeatId } from "@/engine/types";
import { resolveTable, type Density, type TableGeometry, type ZoneName } from "./geometry";
import { useTableStore } from "./store";
import { PieceLayer } from "./PieceLayer";

export interface TableSurfaceProps {
  seats: number;
  /** Force a density tier. Used by the lab to preview other devices. */
  density?: Density;
  /** Games with no hero hand (LRC) pass 0 to reclaim the bottom strip. */
  handZone?: number;
  /**
   * Felt-treatment knobs, all additive and defaulting to today's
   * behaviour — see `ResolveOptions` for what each reserves. A game
   * passes these when it has chrome the table must make room for (a top
   * HUD strip, a bottom sheet's resting height) or a pile that fans and
   * therefore wants sitting high in its region.
   */
  topZone?: number;
  bottomZone?: number;
  pileAnchor?: number;
  onPieceTap?: (id: PieceId) => void;
  /** Debug overlay: seat slots and zone boxes. */
  showGuides?: boolean;
  children?: React.ReactNode;
  className?: string;
  /** Fill the viewport (default) or the parent box. */
  fill?: "viewport" | "parent";
  /** See `ResolveOptions.viewerSeat`. Omit offline; `null` is a spectator. */
  viewerSeat?: SeatId | null;
}

export function TableSurface({
  seats,
  density,
  handZone,
  topZone,
  bottomZone,
  pileAnchor,
  onPieceTap,
  showGuides,
  children,
  className,
  fill = "viewport",
  viewerSeat,
}: TableSurfaceProps) {
  const ref = useRef<HTMLDivElement>(null);
  const setGeometry = useTableStore((s) => s.setGeometry);
  const handHeight = useTableStore((s) => s.geometry?.zones.hand.h ?? null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);

  // ResizeObserver rather than a window listener: this element can be
  // resized by a parent (lab device frame) without the window changing.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const measure = () => {
      const r = el.getBoundingClientRect();
      setSize((prev) =>
        prev && Math.abs(prev.w - r.width) < 1 && Math.abs(prev.h - r.height) < 1
          ? prev
          : { w: r.width, h: r.height },
      );
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!size || size.w === 0 || size.h === 0) return;
    setGeometry(
      resolveTable({
        seats,
        width: size.w,
        height: size.h,
        density,
        handZone,
        topZone,
        bottomZone,
        pileAnchor,
        viewerSeat,
      }),
    );
  }, [size, seats, density, handZone, topZone, bottomZone, pileAnchor, viewerSeat, setGeometry]);

  return (
    <div
      // `touch-none`: the felt removes every native touch behaviour that
      // could otherwise compete with an intentional drag/pan gesture for
      // the same touch. It governs only the browser's own default
      // handling, never JS pointer listeners, so it cannot break
      // anything — it is the belt-and-suspenders half of the pair whose
      // other half is `body { overflow: hidden }` in globals.css.
      //
      // `select-none` is its MOUSE counterpart, and `touch-none` does
      // not cover it. On desktop, dragging the discard fan to pan it
      // started a native text selection instead: selection begins on
      // mousedown, and `usePanZone` cannot `preventDefault` it there
      // without also killing the tap it might still turn out to be. So
      // the felt opts out of selection entirely — there is no text on a
      // card table anyone wants to select anyway.
      className={`felt felt-weave relative touch-none select-none overflow-hidden ${className ?? ""}`}
      style={
        fill === "viewport"
          ? {
              width: "100%",
              height: "100svh",
              paddingTop: "env(safe-area-inset-top)",
              paddingBottom: "env(safe-area-inset-bottom)",
              paddingLeft: "env(safe-area-inset-left)",
              paddingRight: "env(safe-area-inset-right)",
            }
          : { width: "100%", height: "100%" }
      }
    >
      {/* Measured box: everything inside the safe area. `--hand-zone`
          is published so overlays can sit above the hand without
          subscribing to geometry themselves. */}
      <div
        ref={ref}
        className="relative z-1 h-full w-full"
        style={
          {
            "--hand-zone": handHeight !== null ? `${handHeight}px` : undefined,
          } as React.CSSProperties
        }
        // Tapping the bare felt cancels a touch-preview left open by
        // PieceLayer's tap-to-preview/tap-to-confirm (see that file) —
        // `target === currentTarget` means this only fires for a genuine
        // click on THIS div, never one that bubbled up from a piece or
        // an overlay button. A no-op whenever nothing is previewed.
        onClick={(e) => {
          if (e.target === e.currentTarget) useTableStore.getState().setHeroHoverIndex(null);
        }}
      >
        {children}
        <PieceLayer onPieceTap={onPieceTap} />
        {showGuides ? <Guides /> : null}
      </div>
    </div>
  );
}

/** Debug overlay — seat slots, zone boxes, and the play area. */
function Guides() {
  const geometry = useTableStore((s) => s.geometry);
  if (!geometry) return null;

  // Some zone names alias the same Box (e.g. `board` reuses `play` for
  // games with no dedicated board area) — drawing both would stack two
  // identical dashed rects and two labels on the exact same pixels.
  // Keep only the first name to reach each distinct box.
  const seen = new Set<TableGeometry["zones"][ZoneName]>();
  const uniqueZones = Object.entries(geometry.zones).filter(([, z]) => {
    if (seen.has(z)) return false;
    seen.add(z);
    return true;
  });

  return (
    <div className="pointer-events-none absolute inset-0 z-9000">
      {uniqueZones.map(([name, z]) => (
        <div
          key={name}
          className="absolute border border-dashed border-brass-400/35"
          style={{ left: z.x, top: z.y, width: z.w, height: z.h }}
        >
          <span className="absolute -top-4 left-0 text-[9px] tracking-widest text-brass-400/70 uppercase">
            {name}
          </span>
        </div>
      ))}
      {geometry.seats.map((s) => (
        <div
          key={s.seat}
          className="absolute -translate-x-1/2 -translate-y-1/2"
          style={{ left: s.x, top: s.y }}
        >
          <div
            className={`flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-bold ${
              s.isHero
                ? "bg-brass-400 text-felt-950"
                : "bg-bone-400/25 text-bone-50 ring-1 ring-bone-400/40"
            }`}
          >
            {s.seat}
          </div>
          <span className="absolute top-6 left-1/2 -translate-x-1/2 text-[8px] whitespace-nowrap text-bone-400">
            {s.anchor}
          </span>
        </div>
      ))}
    </div>
  );
}

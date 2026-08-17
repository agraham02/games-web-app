"use client";

/**
 * A draggable sheet that lives INSIDE the table, not over the page.
 *
 * Deliberately not vaul, despite vaul being the shadcn drawer: vaul
 * portals to document.body, which would escape the table surface (and
 * the lab's device frame), and it is modal by default. This rail must
 * be non-modal — the whole point is reading the board WHILE you look at
 * your hand, which a modal makes impossible.
 *
 * Snap points are just visible heights in ascending order. Typically:
 *   peek  — a strip above the hand, always present, costs nothing
 *   half  — browse the board without losing sight of your cards
 *   full  — the board is the task
 *
 * ONE MOTION VALUE DRIVES THE HEIGHT, THROUGHOUT. That is the whole
 * design of this file and it replaces a shape that did not work.
 *
 * The original tracked the resting height in React state and the live
 * drag position in a separate Motion `y`, syncing them by hand at drag
 * start (`y.set()` and `setBoxHeight()` together). Those two updates
 * land in different commits — `y.set()` applies immediately, a state
 * setter needs a render — so for one frame the box had its OLD, small
 * height with the NEW, large offset already applied. The result was a
 * visual jump larger than the drag that caused it, which read as "the
 * sheet flies open if you so much as breathe on it".
 *
 * Reading the raw pointer offset in `onDrag` and applying it straight to
 * the same `height` value that renders at rest and animates on settle
 * leaves no seam for the two to desync across. There is nothing to keep
 * in sync because there is only one thing.
 *
 * A second consequence of the old shape is gone with it: `y` translated
 * the box without changing its real height, and `translateY` moves where
 * a box PAINTS, not whether the browser still resolves clicks against
 * the space it vacated — so an inflated-but-translated rail silently ate
 * taps on the hand cards underneath it. A real height has no vacated
 * space.
 */

import { useEffect, useRef } from "react";
import { motion, useMotionValue, animate } from "motion/react";
import { TRANSITIONS } from "@/motion/presets";

export interface PeekRailProps {
  /** Visible heights in px, ascending. Typically [peek, half, full]. */
  snapPoints: readonly number[];
  snapIndex: number;
  onSnapChange: (index: number) => void;
  header?: React.ReactNode;
  children?: React.ReactNode;
  /** Rendered pinned at the bottom of the sheet at the largest snap. */
  footer?: React.ReactNode;
  /**
   * Distance from the bottom of the container, in px. Games pass the
   * hand-zone height so the rail stops above the player's cards —
   * even fully open it must never cover your own hand, or "check the
   * board" turns into "lose sight of what you were comparing".
   */
  offsetBottom?: number;
}

export function PeekRail({
  snapPoints,
  snapIndex,
  onSnapChange,
  header,
  children,
  footer,
  offsetBottom = 0,
}: PeekRailProps) {
  const smallest = snapPoints[0] ?? 0;
  const tallest = snapPoints[snapPoints.length - 1] ?? 0;
  const height = useMotionValue(snapPoints[snapIndex] ?? 0);
  const dragging = useRef(false);

  // Follow controlled changes, but never fight the user mid-drag.
  //
  // Keyed on the resolved target NUMBER, not on `snapPoints` — callers
  // build that array inline, so it is a fresh identity on every render
  // and depending on it re-fired this effect (and started a fresh
  // animation to the height it was already at) on every unrelated
  // re-render of the page. That is a real source of the sheet feeling
  // unsettled.
  const targetHeight = snapPoints[snapIndex] ?? 0;
  useEffect(() => {
    if (dragging.current) return;
    animate(height, targetHeight, TRANSITIONS.ui);
  }, [targetHeight, height]);

  // Raw pointer events on the grab handle rather than Motion's `drag`.
  //
  // Motion's drag always applies a transform to the element it is on,
  // and this element is simultaneously animating its own `height` — so
  // the sheet was being translated AND resized from one gesture, which
  // is the jank. Reading `clientY` directly and feeding only the height
  // keeps exactly one thing moving.
  const gesture = useRef<{ id: number; y: number; from: number; moved: boolean } | null>(null);

  const onPointerDown = (e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragging.current = true;
    gesture.current = { id: e.pointerId, y: e.clientY, from: height.get(), moved: false };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    const delta = g.y - e.clientY; // Dragging UP makes it taller.
    if (Math.abs(delta) > 3) g.moved = true;
    height.set(Math.max(smallest, Math.min(tallest, g.from + delta)));
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    gesture.current = null;
    dragging.current = false;

    // A gesture that never really moved is a TAP — step to the next snap
    // point, so the sheet is fully usable without dragging at all.
    if (!g.moved) {
      animate(height, snapPoints[(snapIndex + 1) % snapPoints.length] ?? 0, TRANSITIONS.ui);
      onSnapChange((snapIndex + 1) % snapPoints.length);
      return;
    }

    const current = height.get();
    let best = 0;
    let bestDist = Infinity;
    snapPoints.forEach((p, i) => {
      const d = Math.abs(p - current);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    });

    animate(height, snapPoints[best] ?? 0, TRANSITIONS.ui);
    onSnapChange(best);
  };

  return (
    <motion.section
      className="absolute right-0 left-0 z-1500 flex flex-col rounded-t-sheet border-t border-brass-400/30 bg-linear-to-b from-felt-800/95 to-felt-900 shadow-[0_-8px_40px_rgb(0_0_0/0.5)] backdrop-blur-lg"
      style={{ height, bottom: offsetBottom }}
    >
      {/* Grab handle — and the only drag surface. Confining the gesture
          here leaves the sheet's own contents free to scroll normally,
          which a whole-sheet drag handler fights with. */}
      <div
        role="button"
        tabIndex={0}
        aria-label="Resize board panel"
        className="w-full shrink-0 cursor-grab touch-none px-3 pt-2.5 pb-1.5 active:cursor-grabbing"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSnapChange((snapIndex + 1) % snapPoints.length);
          }
        }}
      >
        <span className="mx-auto block h-1 w-9 rounded-full bg-bone-50/28" />
      </div>

      {header ? <div className="shrink-0 px-3.5 pb-2">{header}</div> : null}

      {/* Scrollable at EVERY snap, not just the tallest. A resting height
          that shows two meld rows still has to let the player reach the
          rest without first dragging the whole sheet open. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-3.5">{children}</div>

      {footer ? <div className="shrink-0 px-3.5 pt-2 pb-5">{footer}</div> : null}
    </motion.section>
  );
}

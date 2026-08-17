"use client";

/**
 * Floating, collapsible pacing control — dev builds only. Every knob
 * here maps directly to a `GameRuntimeOptions` field `GameHost` reads
 * from `devSettings` and feeds into `useGameRuntime`, so tuning a slider
 * changes REAL runtime behavior, not a cosmetic preview.
 *
 * Deliberately generic: nothing here reads a game's own state beyond
 * the one optional `pendingLabel` string the caller computes however it
 * wants (LRC: "Mia pending — 4 chips → 3 dice"). Every other game built
 * on GameHost gets this panel automatically, with zero per-game wiring,
 * because GameHost renders it once for everyone rather than each game's
 * own page having to remember to.
 */

import { useState } from "react";
import { motion, AnimatePresence, useDragControls } from "motion/react";
import type { PieceId, PieceMeta } from "@/engine/types";
import { useDevSettings } from "./devSettings";
import { DevStateEditor } from "./DevStateEditor";
import { TRANSITIONS } from "@/motion/presets";

export interface DevPanelProps {
  pendingReveal: boolean;
  advance: () => void;
  /** One line of game-specific context about the pending turn, e.g.
   * LRC's "Mia pending — 4 chips → 3 dice". Purely informational. */
  pendingLabel?: string | null;
  /**
   * The live, UNREDACTED game state plus its piece vocabulary. Supplied
   * together or not at all — with both, the panel offers the generic
   * state editor (see DevStateEditor); without them it behaves exactly
   * as it always did.
   */
  debugState?: unknown;
  pieces?: Record<PieceId, PieceMeta>;
  onDebugStateChange?: (next: unknown) => void;
}

export function DevPanel({
  pendingReveal,
  advance,
  pendingLabel,
  debugState,
  pieces,
  onDebugStateChange,
}: DevPanelProps) {
  const [open, setOpen] = useState(true);
  const [editing, setEditing] = useState(false);
  const settings = useDevSettings();
  // `dragListener={false}` + this is what makes ONLY the title bar (not
  // the sliders/checkbox/button underneath it) start a drag — without
  // it, `drag` on the whole card would fight every input inside it for
  // the same pointerdown. The collapsed button has no such conflict
  // (nothing else inside it to interact with), so it drags directly.
  const dragControls = useDragControls();

  if (process.env.NODE_ENV === "production") return null;

  // Shared by both the open panel and the collapsed button so toggling
  // between them never jumps — see devSettings' doc on panelX/panelY.
  const dragProps = {
    drag: true as const,
    dragMomentum: false,
    style: { x: settings.panelX, y: settings.panelY },
    onDragEnd: (_: unknown, info: { offset: { x: number; y: number } }) =>
      settings.setPanelPos(settings.panelX + info.offset.x, settings.panelY + info.offset.y),
  };

  return (
    <div className="pointer-events-auto absolute top-2 left-2 z-2000 text-[11px] text-bone-200">
      <AnimatePresence mode="wait" initial={false}>
        {open ? (
          <motion.div
            key="open"
            {...dragProps}
            dragListener={false}
            dragControls={dragControls}
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={TRANSITIONS.ui}
            className="flex w-56 flex-col gap-2.5 rounded-lg border border-dashed border-brass-400/50 bg-felt-950/92 p-2.5"
          >
            <div className="flex items-center justify-between">
              <span
                onPointerDown={(e) => dragControls.start(e)}
                className="cursor-grab font-bold text-brass-300 select-none active:cursor-grabbing"
              >
                Dev panel
              </span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-bone-400 hover:text-bone-100"
                aria-label="Collapse dev panel"
              >
                ✕
              </button>
            </div>

            <label className="flex items-center gap-1.5 font-semibold">
              <input
                type="checkbox"
                checked={settings.manualMode}
                onChange={(e) => settings.setManualMode(e.target.checked)}
              />
              Manual turns
            </label>

            {settings.manualMode ? (
              <div className="flex flex-col gap-1">
                <span className="text-bone-400">
                  {pendingLabel ?? (pendingReveal ? "Turn pending" : "Nothing pending")}
                </span>
                <button
                  type="button"
                  onClick={advance}
                  disabled={!pendingReveal}
                  className="rounded bg-brass-400 px-2 py-1 font-bold text-felt-950 disabled:opacity-40"
                >
                  Next turn →
                </button>
              </div>
            ) : null}

            <Slider
              label="Speed"
              value={settings.speed}
              onChange={settings.setSpeed}
              min={0.25}
              max={4}
              step={0.25}
              format={(v) => `${v.toFixed(2)}×`}
            />
            <Slider
              label="Turn hold"
              value={settings.turnHoldMs}
              onChange={settings.setTurnHoldMs}
              min={0}
              max={3000}
              step={100}
              format={(v) => `${v}ms`}
            />
            <Slider
              label="Round hold"
              value={settings.roundHoldMs}
              onChange={settings.setRoundHoldMs}
              min={0}
              max={4000}
              step={100}
              format={(v) => `${v}ms`}
            />
            <Slider
              label="End hold"
              value={settings.endHoldMs}
              onChange={settings.setEndHoldMs}
              min={0}
              max={4000}
              step={100}
              format={(v) => `${v}ms`}
            />
            <Slider
              label="Deal speed"
              value={settings.dealSpeed}
              onChange={settings.setDealSpeed}
              min={0.25}
              max={4}
              step={0.25}
              // Same "×" convention as the Speed slider just above —
              // drag right, it gets faster. A raw ms value (the
              // underlying dealStaggerMs) would drag BACKWARDS: lower ms
              // is faster, so dragging right (toward the visually
              // "more" end) would have made dealing slower.
              format={(v) => `${v.toFixed(2)}×`}
            />

            {/* Rules-legal play takes real minutes to reach a 20-card
                hand or a 30-card discard pile, which are exactly the
                states the table layer most needs testing against. Kept
                behind a toggle because it is tall and only occasionally
                wanted. */}
            {debugState !== undefined && pieces && onDebugStateChange ? (
              <div className="flex flex-col gap-1.5 border-t border-bone-50/10 pt-2">
                <button
                  type="button"
                  onClick={() => setEditing((v) => !v)}
                  className="flex items-center justify-between text-left text-[11px] font-bold text-bone-200 hover:text-brass-300"
                >
                  <span>State editor</span>
                  <span className="text-bone-400">{editing ? "▾" : "▸"}</span>
                </button>
                {editing ? (
                  <DevStateEditor
                    state={debugState}
                    pieces={pieces}
                    onChange={onDebugStateChange}
                  />
                ) : null}
              </div>
            ) : null}
          </motion.div>
        ) : (
          <motion.button
            key="closed"
            type="button"
            onClick={() => setOpen(true)}
            {...dragProps}
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={TRANSITIONS.ui}
            className="cursor-grab rounded-lg border border-dashed border-brass-400/50 bg-felt-950/92 px-2 py-1 font-bold text-brass-300 active:cursor-grabbing"
          >
            Dev
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}

function Slider({
  label,
  value,
  onChange,
  min,
  max,
  step,
  format,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
}) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="flex justify-between text-bone-400">
        <span>{label}</span>
        <span className="font-bold text-bone-200">{format(value)}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-brass-400"
      />
    </label>
  );
}

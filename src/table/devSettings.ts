"use client";

/**
 * Dev-only pacing knobs — manual turn stepping, playback speed, and the
 * two hold durations `useGameRuntime` uses (turn-to-turn, and
 * end-of-game-to-summary). Lives in its own module-level store, not
 * component state, specifically so a value survives a rematch: GameHost
 * remounts on `key={gameKey}` to get a fresh `useGameRuntime` (fresh rng,
 * fresh state), and dev-panel component state would reset right along
 * with it — losing the number you just spent a minute tuning the moment
 * you click Rematch. A zustand store outside the remount boundary
 * doesn't have that problem; it resets only on a real page reload.
 *
 * Shared across every game deliberately: DevPanel and GameHost are both
 * generic, and "the pacing I like" is a preference about THIS app's
 * feel, not about any one game.
 */

import { create } from "zustand";
import { STAGGER } from "@/motion/presets";

export const DEFAULT_TURN_HOLD_MS = 900;
export const DEFAULT_END_HOLD_MS = 1200;
export const DEFAULT_ROUND_HOLD_MS = 1000;
/** Mirrors STAGGER.deal's own default so the slider starts where the
 * designed pace already sits. */
export const DEFAULT_DEAL_STAGGER_MS = STAGGER.deal * 1000;

interface DevSettingsState {
  manualMode: boolean;
  speed: number;
  turnHoldMs: number;
  endHoldMs: number;
  roundHoldMs: number;
  /**
   * Multiplier on how tightly a deal cascades — 1 = designed pace, 2 =
   * twice as fast (half the ms between cards), matching `speed`'s own
   * "higher number = faster" convention exactly, so dragging this
   * slider right feels the same way dragging the Speed slider right
   * already does. Deliberately its own knob rather than folded into
   * `speed`, which scales EVERY event uniformly (think time, holds,
   * dealing, all of it) — this only ever touches how tightly a deal
   * cascades. GameHost converts this to the raw ms
   * `ChoreographOptions.dealStaggerMs` actually wants
   * (`DEFAULT_DEAL_STAGGER_MS / dealSpeed`) — storing the multiplier
   * here, not the ms, is what keeps the slider's direction intuitive;
   * storing raw ms directly made "drag right" mean "slower", which is
   * backwards for anything labelled "speed".
   */
  dealSpeed: number;
  /** Drag offset from the panel's default top-2/left-2 corner, in px.
   * Shared by the open panel and the collapsed button (see DevPanel)
   * so dragging one and then toggling to the other doesn't jump. */
  panelX: number;
  panelY: number;
  setManualMode: (v: boolean) => void;
  setSpeed: (v: number) => void;
  setTurnHoldMs: (v: number) => void;
  setEndHoldMs: (v: number) => void;
  setRoundHoldMs: (v: number) => void;
  setDealSpeed: (v: number) => void;
  setPanelPos: (x: number, y: number) => void;
}

export const useDevSettings = create<DevSettingsState>((set) => ({
  manualMode: false,
  speed: 1,
  turnHoldMs: DEFAULT_TURN_HOLD_MS,
  endHoldMs: DEFAULT_END_HOLD_MS,
  roundHoldMs: DEFAULT_ROUND_HOLD_MS,
  dealSpeed: 1,
  panelX: 0,
  panelY: 0,
  setManualMode: (v) => set({ manualMode: v }),
  setSpeed: (v) => set({ speed: v }),
  setTurnHoldMs: (v) => set({ turnHoldMs: v }),
  setEndHoldMs: (v) => set({ endHoldMs: v }),
  setRoundHoldMs: (v) => set({ roundHoldMs: v }),
  setDealSpeed: (v) => set({ dealSpeed: v }),
  setPanelPos: (x, y) => set({ panelX: x, panelY: y }),
}));

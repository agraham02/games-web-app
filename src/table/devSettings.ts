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

export const DEFAULT_TURN_HOLD_MS = 900;
export const DEFAULT_END_HOLD_MS = 1200;

interface DevSettingsState {
  manualMode: boolean;
  speed: number;
  turnHoldMs: number;
  endHoldMs: number;
  /** Drag offset from the panel's default top-2/left-2 corner, in px.
   * Shared by the open panel and the collapsed button (see DevPanel)
   * so dragging one and then toggling to the other doesn't jump. */
  panelX: number;
  panelY: number;
  setManualMode: (v: boolean) => void;
  setSpeed: (v: number) => void;
  setTurnHoldMs: (v: number) => void;
  setEndHoldMs: (v: number) => void;
  setPanelPos: (x: number, y: number) => void;
}

export const useDevSettings = create<DevSettingsState>((set) => ({
  manualMode: false,
  speed: 1,
  turnHoldMs: DEFAULT_TURN_HOLD_MS,
  endHoldMs: DEFAULT_END_HOLD_MS,
  panelX: 0,
  panelY: 0,
  setManualMode: (v) => set({ manualMode: v }),
  setSpeed: (v) => set({ speed: v }),
  setTurnHoldMs: (v) => set({ turnHoldMs: v }),
  setEndHoldMs: (v) => set({ endHoldMs: v }),
  setPanelPos: (x, y) => set({ panelX: x, panelY: y }),
}));

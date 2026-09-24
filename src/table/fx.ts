/**
 * One-shot flourishes — the slam, and LRC's dice.
 *
 * **Why this is not the table store.** Everything in `store.ts` is table
 * STATE: where a piece is, whether it is face up, what it is doing. It
 * is read during render and reconciled wholesale at the end of every
 * batch (`onIdle` calls `reset(definition.placements(...))`, which would
 * wipe anything the game's own `placements()` does not re-derive). A
 * slam is none of that. It is an instantaneous "this just happened",
 * with no state to hold and nothing to reconcile against, and the app
 * already has a channel of exactly that shape: `announce`, which
 * `surfaceEvent` fires straight at sonner without going near the store.
 *
 * Keeping it here buys the piece layer real things: no new subscription
 * in `<Piece>`, no re-render anywhere when a slam fires, and no
 * `Placement` field for the reconcile to eat. `PieceLayer` subscribes
 * once and drives Motion imperatively from the callback.
 */

import type { PieceId } from "@/engine/types";

export interface SlamFx {
  /** The piece being brought down. */
  piece: PieceId;
  /** Pieces already on the table that the landing rattles. */
  shake: PieceId[];
  /** The round-ending tile — plays the louder of the two presets. */
  final: boolean;
}

type Listener = (fx: SlamFx) => void;

const listeners = new Set<Listener>();

/** Subscribe. Returns the unsubscribe, for an effect's cleanup. */
export function onSlam(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emitSlam(fx: SlamFx): void {
  for (const listener of listeners) listener(fx);
}

/** Dice thrown — see the `dice` event. */
export interface DiceFx {
  seat: number;
  faces: string[];
}

const diceListeners = new Set<(fx: DiceFx) => void>();

export function onDice(listener: (fx: DiceFx) => void): () => void {
  diceListeners.add(listener);
  return () => {
    diceListeners.delete(listener);
  };
}

export function emitDice(fx: DiceFx): void {
  for (const listener of diceListeners) listener(fx);
}

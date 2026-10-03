/**
 * One-shot flourishes — the slam, LRC's dice, a press answered, and a move
 * taken back.
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

/**
 * Dice thrown — see the `dice` event. `faces: null` is a throw whose result
 * is not known yet: the player pressed Roll, and the server rolls (see
 * `predict.ts`). The dice tumble from the press until the real `dice`
 * event lands them.
 */
export interface DiceFx {
  seat: number;
  faces: string[] | null;
  /** How many dice, for a throw whose faces are not known yet. */
  count?: number;
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

/**
 * A move this page showed was taken back: refused, or never answered. A
 * flourish started on the press and waiting on the server's answer (LRC's
 * open tumble) stops here instead of running on with nothing to land it.
 */
const takeBackListeners = new Set<() => void>();

export function onTakeBack(listener: () => void): () => void {
  takeBackListeners.add(listener);
  return () => {
    takeBackListeners.delete(listener);
  };
}

export function emitTakeBack(): void {
  for (const listener of takeBackListeners) listener();
}

/**
 * A piece pressed for a move whose result the page cannot know yet — a
 * card off the stock, a tile off the boneyard (see `predict.ts`). It
 * nudges at once, so the press is answered on this screen even while the
 * server decides what it was; the move itself follows with the frame.
 */
export interface PressFx {
  piece: PieceId;
}

const pressListeners = new Set<(fx: PressFx) => void>();

export function onPress(listener: (fx: PressFx) => void): () => void {
  pressListeners.add(listener);
  return () => {
    pressListeners.delete(listener);
  };
}

export function emitPress(fx: PressFx): void {
  for (const listener of pressListeners) listener(fx);
}

/**
 * The piece last tapped, and when — so a move made from a tap can nudge it
 * without every game threading the id through. Noted by `PieceLayer`, read
 * by whoever makes the move, within a moment of the tap.
 */
let lastTap: { piece: PieceId; at: number } | null = null;

export function noteTap(piece: PieceId): void {
  lastTap = { piece, at: Date.now() };
}

/** The piece tapped within `withinMs`, if any. */
export function recentTap(withinMs: number): PieceId | null {
  return lastTap && Date.now() - lastTap.at <= withinMs ? lastTap.piece : null;
}

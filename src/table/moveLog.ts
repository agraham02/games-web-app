"use client";

/**
 * Dev-only record of the last moves an offline table made: who made each one
 * (the player, a bot, a forced draw) and which cards it turned up. For bugs
 * that are reported as "it played my card for me" and cannot be reproduced -
 * the next time it happens, the log says what actually happened, instead of
 * a description of it (the user, 2026-10-31: a drawn wild that went down by
 * itself, twice, with no path in the engine that could do it).
 *
 * Also written to the console, so a log survives the dev panel being shut.
 * Module-level like `devSettings`, so a rematch does not wipe it.
 */

import { create } from "zustand";
import { HERO, type GameEvent, type SeatId } from "@/engine/types";
import type { MoveRecord } from "@/session/GameSession";

export interface MoveLogEntry {
  /** Ever-increasing, so a copied log can be read in order. */
  n: number;
  /** Clock time, to the second, to line up with what was seen. */
  at: string;
  line: string;
}

const KEEP = 60;

interface MoveLogState {
  entries: MoveLogEntry[];
  add: (line: string) => void;
  clear: () => void;
}

let counter = 0;

export const useMoveLog = create<MoveLogState>((set) => ({
  entries: [],
  add: (line) =>
    set((s) => ({
      entries: [...s.entries, { n: ++counter, at: new Date().toLocaleTimeString(), line }].slice(-KEEP),
    })),
  clear: () => set({ entries: [] }),
}));

function who(seat: SeatId): string {
  return seat === HERO ? "you" : `seat ${seat}`;
}

/** One frame, as a line: the move, then where the cards it moved went. */
export function describeFrame<A>(lastAction: MoveRecord<A> | null, events: readonly GameEvent[]): string {
  const head = lastAction
    ? `${who(lastAction.seat)} [${lastAction.by ?? "?"}] ${JSON.stringify(lastAction.action)}`
    : "deal";
  // A round's deal moves the whole deck; the card count says enough.
  if (!lastAction) return `${head} (${events.filter((e) => e.t === "deal").length} cards)`;
  const parts: string[] = [];
  for (const e of events) {
    if (e.t === "draw") parts.push(`${who(e.to)} drew ${e.piece}`);
    else if (e.t === "play") parts.push(`${e.piece} -> ${e.to}`);
    else if (e.t === "sweep") parts.push(`reshuffle (${e.pieces.length})`);
    else if (e.t === "announce") parts.push(`"${e.text}"`);
  }
  return parts.length > 0 ? `${head}: ${parts.join(", ")}` : head;
}

export function logFrame<A>(lastAction: MoveRecord<A> | null, events: readonly GameEvent[]): void {
  if (process.env.NODE_ENV === "production") return;
  const line = describeFrame(lastAction, events);
  useMoveLog.getState().add(line);
  if (process.env.NODE_ENV !== "test") console.debug(`[moves] ${line}`);
}
